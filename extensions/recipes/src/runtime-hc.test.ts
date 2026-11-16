import { expect, it } from "bun:test";
import { HcRuntime } from "./runtime-hc";

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
	expect(HcRuntime.stateOf(CLAUDE_WORKING)).toEqual({
		state: "running",
		from: "live, status working, turn 13",
	});
	expect(HcRuntime.stateOf(claude("blocked")).state).toBe("waiting");
	for (const word of ["idle", "done", "error"])
		expect(HcRuntime.stateOf(claude(word)).state).toBe("idle");
	expect(HcRuntime.stateOf(SHELL_LIVE)).toEqual({
		state: "running",
		from: "live, status null, turn 0",
	});
	expect(HcRuntime.stateOf({ ...SHELL_LIVE, turn: 2 }).state).toBe("idle");
	expect(HcRuntime.stateOf(SHELL_KILLED)).toEqual({
		state: "ended",
		from: "finished (killed)",
	});
	expect(HcRuntime.stateOf(null)).toEqual({ state: "ended", from: "gone" });
});

it("names hc when it is not on PATH", () => {
	expect(HcRuntime.missing("/nonexistent")).toContain(
		"hc (herdr core) is not on PATH",
	);
});
