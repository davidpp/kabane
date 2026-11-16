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
	// A program that never reported is live, whatever its turn count: kabane guesses no status.
	expect(HcRuntime.stateOf(SHELL_LIVE)).toBe("live");
	expect(HcRuntime.stateOf({ ...SHELL_LIVE, turn: 2 })).toBe("live");
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
		JSON.stringify({ ...CLAUDE_WORKING, status: "working" }),
	);
	expect(typed.ok).toBe(false);
	const text = HcRuntime.seen(z, "not json");
	expect(text.ok).toBe(false);
	if (!text.ok) expect(text.error.message).toContain("hc get printed no JSON");
});

// `hc send --json` from hc 0.1.21 on a terminal whose program reported OSC 7501 `blocked`: without
// `--force` it exits 9 and types nothing; with it, it types.
const SEND_BLOCKED = {
	code: 9,
	stdout:
		'{"error":{"hint":"typing would answer its dialog; read its screen first (hc read t3m), or --force","kind":"blocked","message":"t3m is blocked (waiting)"}}',
	stderr: "",
};
const SEND_FORCED = {
	code: 0,
	stdout: '{"started":false,"status":"blocked","turn":0}',
	stderr: "",
};

it("reads hc send's exit: typed, refused because the program is blocked, or failed", () => {
	expect(HcRuntime.sent(z, SEND_FORCED)).toEqual(ok("sent"));
	expect(HcRuntime.sent(z, SEND_BLOCKED)).toEqual(ok("waiting"));
	const failed = HcRuntime.sent(z, {
		code: 3,
		stdout: '{"error":{"kind":"not_found","message":"no terminal t9"}}',
		stderr: "",
	});
	expect(failed.ok).toBe(false);
	if (!failed.ok)
		expect(failed.error.message).toBe(
			"hc send failed (exit 3): no terminal t9",
		);
});

it("passes --force to hc send only when asked, before the terminal and the text", () => {
	expect(HcRuntime.sendArgs("t3m", "hi there", false)).toEqual([
		"send",
		"--json",
		"t3m",
		"hi there",
	]);
	expect(HcRuntime.sendArgs("t3m", "hi there", true)).toEqual([
		"send",
		"--json",
		"--force",
		"t3m",
		"hi there",
	]);
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

it("refuses an empty or blank terminal in every method before it looks for hc", async () => {
	// With PATH emptied, a method that went on to hc would fail naming hc instead.
	const path = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try {
		const hc = HcRuntime.runtime(z);
		for (const terminal of ["", "  "]) {
			const calls = [
				hc.get(terminal),
				hc.read?.(terminal),
				hc.send?.(terminal, "yes"),
				hc.stop(terminal),
				hc.attach?.(terminal),
			];
			for (const result of await Promise.all(calls)) {
				expect(result?.ok).toBe(false);
				if (result !== undefined && !result.ok)
					expect(result.error.message).toBe(
						"No terminal named: kabane never runs hc without the terminal it started",
					);
			}
		}
	} finally {
		process.env.PATH = path;
	}
});

// `hc ls --all --json --label kabane.run=PROBE467` from hc 0.1.21, on a labelled `sleep` before and
// after `hc kill`; and with no terminal carrying the label.
const LS_LIVE =
	'{"hidden_finished":0,"terminals":[{"address":"t2p","agent":"sleep","cwd":"/tmp","name":"probe-467abc","state":"live","turn":0}]}';
const LS_KILLED =
	'{"hidden_finished":0,"terminals":[{"address":"t2p","agent":"sleep","cwd":"/tmp","name":"probe-467abc","reason":"killed","signal":1,"state":"finished","turn":0}]}';
const LS_NONE = '{"hidden_finished":0,"terminals":[]}';

it("finds a run's terminal by the run id's last six among those hc lists for its label", () => {
	const run = "01M7JT0TFJB7MF38VYDW467ABC";
	for (const listed of [LS_LIVE, LS_KILLED])
		expect(HcRuntime.named(z, run, listed)).toEqual(ok("probe-467abc"));
	expect(HcRuntime.named(z, run, LS_NONE)).toEqual(ok(undefined));
	expect(HcRuntime.named(z, "01M7JT0TFJB7MF38VYDWCG0FFF", LS_LIVE)).toEqual(
		ok(undefined),
	);
	const unread = HcRuntime.named(z, run, "{}");
	expect(unread.ok).toBe(false);
});
