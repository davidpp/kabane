// The session modes against the real pinned adapters, over the user's installed CLI: initialize,
// session/new, the mode switch and a model switch only, so nothing is prompted and nothing is spent. Both pinned
// adapters send a mode config option, so both must take that path rather than session/set_mode. A harness whose CLI is not
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
			? `${harness} opens in its auto mode (${ids?.auto}) through its mode config option`
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
					const opened = session.value.modes;
					expect(opened?.availableModes.map((m) => m.id)).toContain(ids?.auto);
					// A mode the user's own settings chose other than the manual one is kept.
					const expected =
						opened?.currentModeId === ids?.manual
							? ids?.auto
							: opened?.currentModeId;
					expect(session.value.mode.current).toBe(expected);
					expect(session.value.mode.via).toBe("config_option");
					console.info(`${harness}: ${session.value.mode.note}`);
					// Both advertise their model as a select option, which is how the loop picks one on
					// every harness; another listed value is taken.
					const model = session.value.configOptions.find(
						(o) => o.category === "model" && o.type === "select",
					);
					if (model?.type !== "select") throw new Error("no model option");
					const other = model.options
						.flatMap((o) => ("options" in o ? o.options : [o]))
						.find((o) => o.value !== model.currentValue);
					if (!other) throw new Error("a single model listed");
					const chosen = await AcpClient.selectModel(
						session.value,
						other.value,
					);
					expect(chosen).toMatchObject({ current: other.value, applied: true });
					console.info(`${harness}: ${chosen.note}`);
				} finally {
					AcpClient.close(conn.value);
					await conn.value.closed;
				}
			},
			TIMEOUT_MS,
		);
	}
});
