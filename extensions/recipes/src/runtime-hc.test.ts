import { expect, it } from "bun:test";
import { err, ok, tryCatch, trySync } from "@cabane/core";
import { z } from "zod";
import { Kabane } from "./result";
import { HcRuntime } from "./runtime-hc";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

// `hc get --json` output from hc 0.1.21, trimmed to the fields the state is read from. The first
// two are a terminal running a shell one-liner kabane started (`status` stays null: a shell never
// reports one), live and then after `hc kill`; the third is a Claude Code terminal mid-turn.
const SHELL_LIVE = JSON.parse(
	'{"address":"t22","exit_code":null,"finished_ms":null,"labels":{"kabane.run":"probe","kabane.sandbox":"1"},"name":"kabane-probe-1","reason":null,"signal":null,"state":"live","status":null,"status_ms":null,"turn":0}',
);
const SHELL_KILLED = JSON.parse(
	'{"address":"t22","exit_code":null,"finished_ms":1794853320484,"labels":{"kabane.run":"probe","kabane.sandbox":"1"},"name":"kabane-probe-1","reason":"killed","signal":1,"state":"finished","status":null,"status_ms":null,"turn":0}',
);
const CLAUDE_WORKING = JSON.parse(
	'{"labels":{"kabane.issue":"JCAB-426"},"name":"jcab-426-tracer","reason":null,"state":"live","status":{"app":"claude-code","state":"working"},"turn":13}',
);
// The other words hc's schema gives `status.state` (`hc schema`, Status): idle, done, blocked, error.
const claude = (state: string) => ({
	...CLAUDE_WORKING,
	status: { app: "claude-code", state },
});

it("maps hc's terminal state and the program's status word to a run state", () => {
	expect(HcRuntime.stateOf(CLAUDE_WORKING)).toBe("running");
	expect(HcRuntime.stateOf(claude("blocked"))).toBe("waiting");
	for (const word of ["idle", "done", "error"])
		expect(HcRuntime.stateOf(claude(word))).toBe("idle");
	expect(HcRuntime.stateOf(SHELL_LIVE)).toBe("running");
	expect(HcRuntime.stateOf({ ...SHELL_LIVE, turn: 2 })).toBe("idle");
	expect(HcRuntime.stateOf(SHELL_KILLED)).toBe("ended");
	expect(HcRuntime.stateOf(null)).toBe("ended");
});

it("reads hc get's JSON through a schema, and refuses a shape hc does not print", () => {
	expect(HcRuntime.seen(z, JSON.stringify(CLAUDE_WORKING))).toEqual(
		ok("running"),
	);
	const renamed = HcRuntime.seen(
		z,
		JSON.stringify({ ...CLAUDE_WORKING, state: undefined, phase: "live" }),
	);
	expect(renamed.ok).toBe(false);
	if (!renamed.ok)
		expect(renamed.error.message).toContain("hc get --json printed a terminal");
	const typed = HcRuntime.seen(
		z,
		JSON.stringify({ ...CLAUDE_WORKING, turn: "13" }),
	);
	expect(typed.ok).toBe(false);
	const text = HcRuntime.seen(z, "not json");
	expect(text.ok).toBe(false);
	if (!text.ok) expect(text.error.message).toContain("hc get printed no JSON");
});

it("names hc when it is not on PATH", () => {
	expect(HcRuntime.missing("/nonexistent")).toContain(
		"hc (herdr core) is not on PATH",
	);
});

it("names a terminal from the title and the run id's last six, within hc's rules", () => {
	expect(HcRuntime.terminalName("01M7JT0TFJB7MF38VYDWCG8PKX", "research")).toBe(
		"research-cg8pkx",
	);
	const long = HcRuntime.terminalName(
		"01M7JT0TFJB7MF38VYDWCG8PKX",
		"Preliminary Research: the long one",
	);
	expect(long).toBe("preliminary-research-t-cg8pkx");
	expect(long).toMatch(/^[a-z0-9_-]{1,32}$/);
});
