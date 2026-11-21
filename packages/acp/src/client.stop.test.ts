// Closing a spawned harness, against a real child that does not want to stop
// (`scripts/stubborn-agent.ts`): whatever `close` or a stopped start awaits is what the host
// waits for before it exits, so the harness and its child are checked the moment it settles.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@kabane/core";
import { AcpClient } from "./client";

const AGENT = join(import.meta.dir, "../scripts/stubborn-agent.ts");

// Gone, or a zombie its new parent has yet to reap: either way it runs nothing.
const running = (pid: number): boolean => {
	const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
		.stdout.toString()
		.trim();
	return stat !== "" && !stat.startsWith("Z");
};

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

// Killed outright at the end of every test, so a test that fails leaves nothing running.
const spawned: number[] = [];
afterEach(() => {
	for (const pid of spawned.splice(0))
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
});

// The calls that send a process group a signal; a probe (signal 0) delivers none.
const groupSignals = (kill: ReturnType<typeof spyOn<NodeJS.Process, "kill">>) =>
	kill.mock.calls.filter(([pid, signal]) => pid < 0 && signal !== 0);

// Whether anything is left in the harness's process group.
const groupAlive = (pid: number): boolean => {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
};

const launch = (
	stage: "handshake" | "open" | "deaf",
	options: { signal?: AbortSignal; eof?: boolean } = {},
) => {
	const dir = mkdtempSync(join(tmpdir(), "acp-stop-"));
	dirs.push(dir);
	const pidfile = join(dir, "pids");
	const args = [AGENT, pidfile, stage, ...(options.eof ? ["eof"] : [])];
	const connecting = AcpClient.spawn("claude", dir, {
		overrides: { command: process.execPath, args },
		onPermission: async () => ok("allow"),
		...(options.signal ? { signal: options.signal } : {}),
	});
	const pids = async (): Promise<number[]> => {
		for (let i = 0; i < 1000 && !existsSync(pidfile); i++) await Bun.sleep(5);
		const read = readFileSync(pidfile, "utf8").split(" ").map(Number);
		spawned.push(...read);
		return read;
	};
	return { dir, connecting, pids };
};

describe("AcpClient stopping a harness that ignores stdin EOF and SIGTERM", () => {
	it("close of an open session settles once the harness and the child it started have exited", async () => {
		const { dir, connecting, pids } = launch("open");
		const conn = await connecting;
		if (!conn.ok) throw conn.error;
		const session = await AcpClient.newSession(conn.value, {
			cwd: dir,
			mcpServers: [],
		});
		expect(session.ok).toBe(true);
		const [harness = 0, child = 0] = await pids();
		expect([running(harness), running(child)]).toEqual([true, true]);

		await AcpClient.close(conn.value);
		expect([running(harness), running(child)]).toEqual([false, false]);
	}, 10_000);

	it("a start aborted before initialize answers settles once the harness and its child have exited", async () => {
		const stop = new AbortController();
		const { connecting, pids } = launch("handshake", { signal: stop.signal });
		const [harness = 0, child = 0] = await pids();
		expect([running(harness), running(child)]).toEqual([true, true]);

		stop.abort();
		const conn = await connecting;
		expect(conn.ok).toBe(false);
		expect([running(harness), running(child)]).toEqual([false, false]);
	}, 10_000);

	// A harness can die hours before the board quits, and once its group is empty the OS may hand
	// its pid to a new group leader: signalling the old group then would reach someone else's.
	it("a harness that dies by itself has its group swept at that exit, and close signals no group after", async () => {
		const { dir, connecting, pids } = launch("open");
		const conn = await connecting;
		if (!conn.ok) throw conn.error;
		await AcpClient.newSession(conn.value, { cwd: dir, mcpServers: [] });
		const [harness = 0, child = 0] = await pids();

		process.kill(harness, "SIGKILL");
		for (let i = 0; i < 300 && groupAlive(harness); i++) await Bun.sleep(10);
		expect(groupAlive(harness)).toBe(false);
		expect(running(child)).toBe(false);

		const kill = spyOn(process, "kill");
		try {
			await AcpClient.close(conn.value);
			expect(groupSignals(kill)).toEqual([]);
		} finally {
			kill.mockRestore();
		}
	}, 10_000);

	it("close of a harness that stopped reading in the middle of a large prompt still settles", async () => {
		const { dir, connecting, pids } = launch("deaf");
		const conn = await connecting;
		if (!conn.ok) throw conn.error;
		const session = await AcpClient.newSession(conn.value, {
			cwd: dir,
			mcpServers: [],
		});
		if (!session.ok) throw session.error;
		const [harness = 0, child = 0] = await pids();
		const big = [{ type: "text" as const, text: "x".repeat(8 << 20) }];
		void (async () => {
			for await (const _ of AcpClient.prompt(session.value, big));
		})().catch(() => {});
		await Bun.sleep(200);

		const closed = await Promise.race([
			AcpClient.close(conn.value).then(() => "settled"),
			Bun.sleep(6_000).then(() => "still waiting"),
		]);
		expect(closed).toBe("settled");
		expect([running(harness), running(child)]).toEqual([false, false]);
	}, 10_000);

	it("close settles once the group is empty, after its SIGKILL, when the harness left a child behind", async () => {
		const { dir, connecting, pids } = launch("open", { eof: true });
		const conn = await connecting;
		if (!conn.ok) throw conn.error;
		await AcpClient.newSession(conn.value, { cwd: dir, mcpServers: [] });
		const [harness = 0, child = 0] = await pids();

		await AcpClient.close(conn.value);
		expect(groupAlive(harness)).toBe(false);
		expect(running(child)).toBe(false);
	}, 10_000);
});
