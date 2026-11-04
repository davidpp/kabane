// How the log's tool events fold into rows: one per call whatever its events, a group for a run of
// reads and searches, and the caps an opened row is held to.
import { describe, expect, it } from "bun:test";
import type { ActivityEvent } from "./ports";
import { ToolRows } from "./tool-rows";

const T0 = "2026-11-04T10:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();

let seq = 0;
const ev = (event: Omit<ActivityEvent, "seq" | "at"> & { at?: string }) => ({
	seq: ++seq,
	at: T0,
	...event,
});

const shape = (rows: readonly ToolRows.Row[]) =>
	rows.map((row) =>
		row.type === "event"
			? row.event.summary
			: row.type === "call"
				? [row.call.summary, row.call.status]
				: ["group", row.group.calls.map((call) => call.summary)],
	);

describe("ToolRows.rows", () => {
	it("folds a call and its end into one row that took the end's title, status and detail", () => {
		const rows = ToolRows.rows(
			[
				ev({ type: "tool_call", summary: "Terminal", callId: "t1" }),
				ev({
					type: "tool_completed",
					summary: "`bun test`",
					callId: "t1",
					at: at(1_400),
					detail: { kind: "execute", output: "3 pass" },
				}),
				ev({ type: "text", summary: "All green." }),
			],
			true,
		);
		expect(shape(rows)).toEqual([["`bun test`", "completed"], "All green."]);
		const [first] = rows;
		expect(first?.type === "call" && ToolRows.duration(first.call)).toBe(
			"1.4s",
		);
	});

	it("keeps two lanes' calls apart when they share an id", () => {
		const rows = ToolRows.rows(
			[
				ev({
					type: "tool_call",
					summary: "Edit a.ts",
					callId: "t1",
					lane: "a",
				}),
				ev({
					type: "tool_call",
					summary: "Edit b.ts",
					callId: "t1",
					lane: "b",
				}),
				ev({
					type: "tool_failed",
					summary: "Edit b.ts",
					callId: "t1",
					lane: "b",
				}),
			],
			true,
		);
		expect(shape(rows)).toEqual([
			["Edit a.ts", "running"],
			["Edit b.ts", "failed"],
		]);
	});

	it("pairs an end with no id to the open call of the same title, and leaves the rest unknown", () => {
		const rows = ToolRows.rows(
			[
				ev({ type: "tool_use", summary: "mcp__kabane__kabane_list" }),
				ev({ type: "tool_use", summary: "kabane_edit JREP-1" }),
				ev({ type: "tool_result", summary: "kabane_edit JREP-1" }),
				ev({ type: "tool_result", summary: "ok" }),
			],
			true,
		);
		expect(shape(rows)).toEqual([
			["mcp__kabane__kabane_list", "unknown"],
			["kabane_edit JREP-1", "completed"],
			["ok", "completed"],
		]);
	});

	it("stops a call's spinner once the card is over without its end", () => {
		const rows = ToolRows.rows(
			[ev({ type: "tool_call", summary: "Terminal", callId: "t1" })],
			false,
		);
		expect(shape(rows)).toEqual([["Terminal", "unknown"]]);
	});

	it("groups a run of reads and searches with nothing said between them, and only that", () => {
		const read = (path: string, callId: string) =>
			ev({
				type: "tool_call",
				summary: `Read ${path}`,
				callId,
				detail: { kind: "read" },
			});
		const rows = ToolRows.rows(
			[
				read("a.ts", "r1"),
				ev({ type: "tool_completed", summary: "Read a.ts", callId: "r1" }),
				read("b.ts", "r2"),
				ev({
					type: "tool_call",
					summary: "grep -n foo",
					callId: "s1",
					detail: { kind: "search" },
				}),
				ev({ type: "text", summary: "Found it." }),
				read("c.ts", "r3"),
				ev({
					type: "tool_call",
					summary: "Edit c.ts",
					callId: "e1",
					detail: { kind: "edit" },
				}),
			],
			true,
		);
		expect(shape(rows)).toEqual([
			["group", ["Read a.ts", "Read b.ts", "grep -n foo"]],
			"Found it.",
			["Read c.ts", "running"],
			["Edit c.ts", "running"],
		]);
		const [group] = rows;
		if (group?.type !== "group") throw new Error("expected a group");
		expect(group.group.key).toBe("group:\u0000r1");
		expect(ToolRows.groupLabel(group.group)).toBe(
			"exploring · 2 reads, 1 search",
		);
	});

	it("reads a call with no kind by its tool's name, and a kind over the name", () => {
		const call = (summary: string, kind?: string): ToolRows.Call => ({
			key: summary,
			at: T0,
			summary,
			status: "completed",
			detail: kind ? { kind } : {},
		});
		expect(ToolRows.explores(call("Read src/app.tsx"))).toBe("read");
		expect(ToolRows.explores(call("WebFetch https://x"))).toBe("fetch");
		expect(ToolRows.explores(call("Read notes", "other"))).toBeNull();
		expect(ToolRows.explores(call("mcp__kabane__kabane_list"))).toBeNull();
		expect(
			ToolRows.groupLabel({
				key: "g",
				calls: [call("Read a"), call("Read b"), call("WebFetch c")],
			}),
		).toBe("explored · 2 reads, 1 fetch");
	});
});

describe("ToolRows.toolParts", () => {
	it("splits a tool from what it was called on, and keeps a command whole and to its first line", () => {
		expect(ToolRows.toolParts("Read src/app.tsx")).toEqual({
			name: "Read",
			args: "src/app.tsx",
		});
		expect(ToolRows.toolParts("mcp__kabane__kabane_list")).toEqual({
			name: "mcp__kabane__kabane_list",
			args: "",
		});
		expect(ToolRows.toolParts("`git status --short`")).toEqual({
			name: "`git status --short`",
			args: "",
		});
		expect(ToolRows.toolParts("python3 - <<'EOF'\nprint(1)\nEOF")).toEqual({
			name: "python3",
			args: "- <<'EOF'…",
		});
	});
});

describe("ToolRows.head and tail", () => {
	it("cuts a head by lines and by characters, ending in an ellipsis", () => {
		expect(ToolRows.head("a\nb", 2, 10)).toBe("a\nb");
		expect(ToolRows.head("a\nb\nc", 2, 10)).toBe("a\nb…");
		expect(ToolRows.head("abcdefghij", 3, 5)).toBe("abcd…");
	});

	it("keeps an output's tail behind a count of the lines before it", () => {
		const output = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		expect(ToolRows.tail(output, 4, 1000)).toBe(
			"(9 earlier lines)\nline 10\nline 11\nline 12",
		);
		expect(ToolRows.tail("short", 4, 1000)).toBe("short");
		expect(ToolRows.tail("x".repeat(20), 4, 6)).toBe("…xxxxx");
	});
});

describe("ToolRows.patch", () => {
	const file = (count: number) =>
		`${Array.from({ length: count }, (_, i) => `line ${i}`).join("\n")}\n`;

	it("makes a unified patch of a changed file, a created one all additions", () => {
		const old = file(40);
		const changed = old.replace("line 2\n", "LINE 2\n");
		expect(
			ToolRows.patch({ path: "a.ts", oldText: old, newText: changed }, 50),
		).toEqual({
			patch:
				"@@ -1,6 +1,6 @@\n line 0\n line 1\n-line 2\n+LINE 2\n line 3\n line 4\n line 5\n",
			cut: 0,
		});
		expect(ToolRows.patch({ path: "n.md", newText: "hi\n" }, 50)).toEqual({
			patch: "@@ -0,0 +1,1 @@\n+hi\n",
			cut: 0,
		});
		expect(
			ToolRows.patch({ path: "a.ts", oldText: old, newText: old }, 50),
		).toEqual({
			patch: "",
			cut: 0,
		});
	});

	it("holds a big patch to its lines, cutting the hunk that overflows with its counts made true", () => {
		const old = file(40);
		const changed = old
			.replace("line 2\n", "LINE 2\n")
			.replace("line 30\n", "LINE 30\n");
		const { patch, cut } = ToolRows.patch(
			{ path: "a.ts", oldText: old, newText: changed },
			11,
		);
		expect(cut).toBe(4);
		expect(patch.split("\n").filter((l) => l.startsWith("@@"))).toEqual([
			"@@ -1,6 +1,6 @@",
			"@@ -28,4 +28,3 @@",
		]);
	});
});
