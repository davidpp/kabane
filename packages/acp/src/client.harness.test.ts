// The session modes against the real pinned adapters, over the user's installed CLI: initialize
// and session/new only, so nothing is prompted and nothing is spent. A harness whose CLI is not
// on PATH is skipped, with the reason in the test's name.
import { describe, expect, it } from "bun:test";
import { err } from "@cabane/core";
import { AcpClient } from "./client";
import { Harnesses } from "./harnesses";

// The first run cold-starts npx.
const TIMEOUT_MS = 180_000;

describe("AcpClient session modes on the real adapters", () => {
	for (const harness of ["claude", "codex"] as const) {
		const cli = Harnesses.installedCli(harness);
		const ids = Harnesses.modes(harness);
		const name = cli.ok
			? `${harness} opens in its auto mode (${ids?.auto})`
			: `${harness} opens in its auto mode (skipped: ${cli.error.message})`;
		it.skipIf(!cli.ok)(
			name,
			async () => {
				const conn = await AcpClient.spawn(harness, process.cwd(), {
					onPermission: async () => err(new Error("never prompted")),
					handshakeMs: TIMEOUT_MS,
					profile: {
						...Harnesses.COPILOT,
						env: { ...Harnesses.SESSION_ENV, ...(cli.ok ? cli.value : {}) },
					},
				});
				if (!conn.ok) throw conn.error;
				try {
					const session = await AcpClient.newSession(conn.value, {
						cwd: process.cwd(),
						mcpServers: [],
					});
					if (!session.ok) throw session.error;
					const opened = session.value.active.modes;
					expect(opened?.availableModes.map((m) => m.id)).toContain(ids?.auto);
					// A mode the user's own settings chose other than the manual one is kept.
					const expected =
						opened?.currentModeId === ids?.manual
							? ids?.auto
							: opened?.currentModeId;
					expect(session.value.mode.current).toBe(expected);
				} finally {
					AcpClient.close(conn.value);
					await conn.value.closed;
				}
			},
			TIMEOUT_MS,
		);
	}
});
