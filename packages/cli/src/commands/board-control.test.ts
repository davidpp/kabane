// The board's control channel over real Unix sockets: a request and its reply, the errors a client
// reads, and the socket gone however the board comes down. A crash or a kill is a child process
// listening the way `kabane board` does.
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@cabane/core";
import { BoardControl } from "./board-control";

const HOME = mkdtempSync(join(tmpdir(), "kabane-control-"));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

// A pid no board here runs as: the channel only names its socket after it.
let nextPid = 900_000;
const pidOf = (): number => nextPid++;

// A child that listens as a board does, prints `ready`, then does what `then` says.
const child = async (pid: number, then: string) => {
	const proc = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const { BoardControl } = await import(${JSON.stringify(join(import.meta.dir, "board-control.ts"))});
			const { ok } = await import("@cabane/core");
			const listening = BoardControl.listen(BoardControl.socketPath(${JSON.stringify(HOME)}, ${pid}), async () => ok("X-1"));
			if (!listening.ok) throw listening.error;
			console.log("ready");
			${then}`,
		],
		{ cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
	);
	const reader = proc.stdout.getReader();
	const first = await reader.read();
	expect(new TextDecoder().decode(first.value)).toContain("ready");
	reader.releaseLock();
	return proc;
};

describe("BoardControl", () => {
	it("hands the board the id and replies with what it opened", async () => {
		const pid = pidOf();
		const asked: string[] = [];
		const listening = BoardControl.listen(
			BoardControl.socketPath(HOME, pid),
			async (id) => {
				asked.push(id);
				return id === "JRET-99"
					? err(new Error("JRET-99 not found"))
					: ok("JCAB-12");
			},
		);
		if (!listening.ok) throw listening.error;
		try {
			expect(await BoardControl.send(HOME, pid, "jcab-12")).toEqual(
				ok("JCAB-12"),
			);
			const unknown = await BoardControl.send(HOME, pid, "JRET-99");
			expect(unknown.ok ? "" : unknown.error.message).toBe("JRET-99 not found");
			expect(asked).toEqual(["jcab-12", "JRET-99"]);
		} finally {
			listening.value.close();
		}
	});

	it("listens where only this user can reach it, and removes the socket on close", async () => {
		const pid = pidOf();
		const path = BoardControl.socketPath(HOME, pid);
		expect(path).toBe(join(HOME, "run", `board-${pid}.sock`));
		const listening = BoardControl.listen(path, async () => ok("X-1"));
		if (!listening.ok) throw listening.error;
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(HOME, "run")).mode & 0o777).toBe(0o700);
		listening.value.close();
		expect(existsSync(path)).toBe(false);
		const gone = await BoardControl.send(HOME, pid, "X-1");
		expect(gone.ok ? "" : gone.error.message).toBe(
			`no board running as pid ${pid}`,
		);
	});

	it("answers a request that is not one with what it expects", async () => {
		const pid = pidOf();
		const path = BoardControl.socketPath(HOME, pid);
		const listening = BoardControl.listen(path, async () => ok("X-1"));
		if (!listening.ok) throw listening.error;
		try {
			let reply = "";
			const closed = new Promise<void>((resolve) => {
				void Bun.connect({
					unix: path,
					socket: {
						open: (socket) => {
							socket.write("open JCAB-12\n");
						},
						data: (_socket, chunk) => {
							reply += chunk.toString();
						},
						close: () => resolve(),
					},
				});
			});
			await closed;
			expect(JSON.parse(reply)).toEqual({ error: 'expected {"open":"<id>"}' });
		} finally {
			listening.value.close();
		}
	});

	it("falls back to the temp dir when the home's path is too long for a socket", () => {
		const deep = join(HOME, "x".repeat(120));
		expect(BoardControl.socketPath(deep, 4242)).toBe(
			join(tmpdir(), "kabane-board-4242.sock"),
		);
	});

	it("leaves no socket behind when the board crashes", async () => {
		const pid = pidOf();
		const proc = await child(pid, 'throw new Error("boom");');
		expect(await proc.exited).not.toBe(0);
		expect(existsSync(BoardControl.socketPath(HOME, pid))).toBe(false);
	});

	it("reads a board killed outright as not running, and clears its socket", async () => {
		const pid = pidOf();
		const proc = await child(pid, "setInterval(() => {}, 1000);");
		const path = BoardControl.socketPath(HOME, pid);
		expect(await BoardControl.send(HOME, pid, "X-1")).toEqual(ok("X-1"));
		proc.kill("SIGKILL");
		await proc.exited;
		expect(existsSync(path)).toBe(true);
		const dead = await BoardControl.send(HOME, pid, "X-1");
		expect(dead.ok ? "" : dead.error.message).toBe(
			`no board running as pid ${pid}`,
		);
		expect(existsSync(path)).toBe(false);
	});

	it("replaces a socket a dead board left under its own pid", async () => {
		const pid = pidOf();
		const proc = await child(pid, "setInterval(() => {}, 1000);");
		proc.kill("SIGKILL");
		await proc.exited;
		const listening = BoardControl.listen(
			BoardControl.socketPath(HOME, pid),
			async () => ok("X-2"),
		);
		if (!listening.ok) throw listening.error;
		try {
			expect(await BoardControl.send(HOME, pid, "X-2")).toEqual(ok("X-2"));
		} finally {
			listening.value.close();
		}
	});
});
