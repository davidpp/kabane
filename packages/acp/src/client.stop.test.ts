// Closing a spawned harness, against a real child that does not want to stop
// (`scripts/stubborn-agent.ts`): whatever `close` or a stopped start awaits is what the host
// waits for before it exits, so the harness and its child are checked the moment it settles.
import { afterEach, describe, expect, it } from "bun:test";
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

const launch = (stage: "handshake" | "open", signal?: AbortSignal) => {
	const dir = mkdtempSync(join(tmpdir(), "acp-stop-"));
	dirs.push(dir);
	const pidfile = join(dir, "pids");
	const connecting = AcpClient.spawn("claude", dir, {
		overrides: { command: process.execPath, args: [AGENT, pidfile, stage] },
		onPermission: async () => ok("allow"),
		...(signal ? { signal } : {}),
	});
	const pids = async (): Promise<number[]> => {
		for (let i = 0; i < 1000 && !existsSync(pidfile); i++) await Bun.sleep(5);
		return readFileSync(pidfile, "utf8").split(" ").map(Number);
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
		const { connecting, pids } = launch("handshake", stop.signal);
		const [harness = 0, child = 0] = await pids();
		expect([running(harness), running(child)]).toEqual([true, true]);

		stop.abort();
		const conn = await connecting;
		expect(conn.ok).toBe(false);
		expect([running(harness), running(child)]).toEqual([false, false]);
	}, 10_000);
});
