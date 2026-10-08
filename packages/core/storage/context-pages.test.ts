import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteDb } from "@cabane/sqlite";
import { z } from "zod";
import { createCorpusTracker } from "../../cli/issue-corpus-harness";
import {
	CONTEXT_BYTES,
	type ContextPage,
	type ContextPageOptions,
} from "../context-output";
import type { DbProvider } from "../db/port";
import { TABLES } from "../db/tables";
import { err, ok, type Result } from "../result";
import { Runtime, withDb } from "../runtime";
import { serializedBytes } from "../task-output";
import { configureTestRuntime } from "../testing";
import { Planner } from "./index";

let tracker: Extract<
	Awaited<ReturnType<typeof createCorpusTracker>>,
	{ ok: true }
>["value"];
let id: string;
beforeEach(async () => {
	const seeded = await createCorpusTracker({ synthetic: true });
	expect(seeded.ok).toBe(true);
	if (!seeded.ok) return;
	tracker = seeded.value;
	id = tracker.ids[24] ?? "";
	configureTestRuntime();
});
afterEach(() => {
	tracker?.close();
	configureTestRuntime();
});
const collect = async (
	taskId = id,
	options: ContextPageOptions = {},
): Promise<Result<{ markdown: string; pages: ContextPage[] }>> => {
	const pages: ContextPage[] = [];
	let markdown = "";
	let cursor: string | undefined;
	do {
		const result = await Planner.getContextPage(tracker.home, taskId, {
			...options,
			cursor,
		});
		if (!result.ok) return result;
		const page = result.value;
		expect(serializedBytes(page)).toBeLessThanOrEqual(CONTEXT_BYTES);
		expect(page.offset).toBe(markdown.length);
		expect(page.taskId).toBe(taskId);
		expect(Object.keys(page)[0]).toBe("completeness");
		expect(page.markdown).not.toMatch(/[\ud800-\udbff]$/u);
		expect(page.markdown).not.toMatch(/^[\udc00-\udfff]/u);
		expect(page.completeness.selectedComplete).toBe(
			page.nextCursor === undefined,
		);
		markdown += page.markdown;
		pages.push(page);
		cursor = page.nextCursor;
		expect(pages.length).toBeLessThan(200);
	} while (cursor);
	return ok({ markdown, pages });
};

describe("bounded selected context", () => {
	it("reconstructs every fixture description and human comment, giant items and complete legacy markdown", async () => {
		for (const taskId of [...tracker.ids.slice(0, 24), id]) {
			const full = await Planner.assembleContext(tracker.home, taskId, {
				deref: false,
			});
			const bounded = await collect(taskId, { deref: false });
			expect(full.ok).toBe(true);
			expect(bounded.ok).toBe(true);
			if (!full.ok || !bounded.ok) return;
			expect(bounded.value.markdown).toBe(full.value);
			const comments = await Planner.getComments(tracker.home, taskId);
			const task = await Planner.getTask(tracker.home, taskId);
			if (!comments.ok || !task.ok || !task.value) return;
			if (task.value.description)
				expect(bounded.value.markdown).toContain(task.value.description);
			for (const comment of comments.value.filter(
				(c) => c.authorType === "human",
			))
				expect(bounded.value.markdown).toContain(comment.content);
		}
		const bounded = await collect(id, { deref: false });
		if (!bounded.ok) return;
		expect(bounded.value.markdown).toContain("SYNTHETIC_EARLY_STEERING");
		expect(bounded.value.markdown).toContain("SYNTHETIC_LATE_STEERING");
		expect(bounded.value.markdown).not.toContain("SYNTHETIC_NOISE");
		const first = bounded.value.pages[0];
		const middle =
			bounded.value.pages[Math.floor(bounded.value.pages.length / 2)];
		const last = bounded.value.pages.at(-1);
		expect(bounded.value.pages.length).toBeGreaterThan(3);
		expect(first?.completeness.descriptionComplete).toBe(false);
		expect(first?.completeness.humanSteeringComplete).toBe(false);
		expect(middle?.completeness.selectedComplete).toBe(false);
		expect(middle?.completeness.humanSteeringComplete).toBe(false);
		expect(
			bounded.value.pages.some(
				(page) =>
					page.completeness.descriptionComplete &&
					!page.completeness.humanSteeringComplete,
			),
		).toBe(true);
		expect(last?.completeness.descriptionComplete).toBe(true);
		expect(last?.completeness.humanSteeringComplete).toBe(true);
		expect(last?.completeness.remainingSections).toEqual([]);
		expect(first?.retrieval).toContain(
			"Finish required description and human steering before starting work",
		);
	});
	it("distinguishes omitted versus empty sections, canonicalizes duplicates/order and binds equivalent selections", async () => {
		const empty = await Planner.addTask(tracker.home, { title: "Empty" });
		if (!empty.ok) return;
		const selected = await Planner.getContextPage(
			tracker.home,
			empty.value.id,
			{ sections: ["description", "discussion"] },
		);
		if (!selected.ok) return;
		expect(selected.value.markdown).toBe("");
		expect(selected.value.completeness).toMatchObject({
			selectedComplete: true,
			descriptionComplete: true,
			humanSteeringComplete: true,
		});
		const omitted = await Planner.getContextPage(tracker.home, empty.value.id, {
			sections: [],
		});
		if (!omitted.ok) return;
		expect(omitted.value.completeness).toMatchObject({
			selectedComplete: true,
			descriptionComplete: false,
			humanSteeringComplete: false,
		});
		expect(omitted.value.completeness.omittedSections).toContain("discussion");
		const first = await Planner.getContextPage(tracker.home, id, {
			sections: ["discussion", "description", "discussion"],
		});
		if (!first.ok) return;
		expect(first.value.markdown.startsWith("## Description")).toBe(true);
		const second = await Planner.getContextPage(tracker.home, id, {
			sections: ["description", "discussion"],
			cursor: first.value.nextCursor,
		});
		expect(second.ok).toBe(true);
		const discussion = await collect(id, { sections: ["discussion"] });
		if (!discussion.ok) return;
		expect(discussion.value.pages[0]?.completeness.descriptionComplete).toBe(
			false,
		);
		expect(
			discussion.value.pages.at(-1)?.completeness.humanSteeringComplete,
		).toBe(true);
	});
	it("full and bounded position include all106 children, deferred and closed, without changing global query defaults", async () => {
		const children = await Planner.queryTasks(tracker.home, {
			parentTaskId: id,
			includeClosed: true,
			includeDeferred: true,
			limit: 200,
		});
		if (!children.ok) return;
		expect(children.value).toHaveLength(106);
		const first = children.value[0];
		const last = children.value.at(-1);
		if (!first || !last) return;
		expect(
			(
				await Planner.updateTask(tracker.home, first.id, {
					deferUntil: "2099-01-01T00:00:00.000Z",
				})
			).ok,
		).toBe(true);
		expect(
			(await Planner.updateTask(tracker.home, last.id, { state: "done" })).ok,
		).toBe(true);
		const legacy = await Planner.queryTasks(tracker.home, { parentTaskId: id });
		if (legacy.ok) expect(legacy.value).toHaveLength(100);
		const full = await Planner.assembleContext(tracker.home, id, {
			deref: false,
		});
		const bounded = await collect(id, { sections: ["position"], deref: false });
		if (!full.ok || !bounded.ok) return;
		expect(full.value).toContain("Subtasks (106)");
		expect(bounded.value.markdown).toContain("Subtasks (106)");
		for (const child of children.value)
			expect(bounded.value.markdown).toContain(child.title);
		expect(full.value).toContain(bounded.value.markdown);
		expect(bounded.value.markdown).toContain("(done)");
		const noChildren = await collect(id, {
			sections: ["position"],
			includeSubtasks: false,
		});
		if (noChildren.ok)
			expect(noChildren.value.markdown).not.toContain("Subtasks");
	});
	it("recovers huge escaping-heavy Unicode worklogs/ref notes and capped/missing file metadata", async () => {
		const huge = '🧭漢字"\\\n\t'.repeat(10000);
		expect(
			(
				await Planner.addWorkLog(tracker.home, {
					taskId: id,
					refs: [{ uri: "commit:huge", label: huge }],
					note: huge,
				})
			).ok,
		).toBe(true);
		const file = join(tracker.root, "large-unicode.txt");
		writeFileSync(file, "漢🧭".repeat(10000));
		expect(
			(
				await Planner.addContextRef(tracker.home, {
					taskId: id,
					kind: "file",
					uri: `file:${file}`,
					note: huge,
				})
			).ok,
		).toBe(true);
		expect(
			(
				await Planner.addContextRef(tracker.home, {
					taskId: id,
					kind: "file",
					uri: `file:${join(tracker.root, "missing-file")}`,
					note: "MISSING_NOTE",
				})
			).ok,
		).toBe(true);
		const full = await Planner.assembleContext(tracker.home, id);
		const bounded = await collect();
		if (!full.ok || !bounded.ok) return;
		expect(bounded.value.markdown).toBe(full.value);
		expect(bounded.value.markdown).toContain(huge);
		expect(bounded.value.markdown).toContain("[truncated:");
		expect(bounded.value.markdown).toContain("missing file:");
		expect(bounded.value.markdown).toContain("MISSING_NOTE");
		const pointers = await collect(id, { sections: ["context"], deref: false });
		if (pointers.ok) {
			expect(pointers.value.markdown).not.toContain("[truncated:");
			expect(pointers.value.markdown).toContain(huge);
		}
	});
	it("bounded unreadable file pointers disclose host availability without changing full fallback", async () => {
		expect(
			(
				await Planner.addContextRef(tracker.home, {
					taskId: id,
					kind: "spec",
					uri: "file:\u0000unreadable",
					note: "UNREADABLE_NOTE",
				})
			).ok,
		).toBe(true);
		const bounded = await collect(id, { sections: ["context"] });
		const full = await Planner.assembleContext(tracker.home, id);
		if (!bounded.ok || !full.ok) return;
		expect(bounded.value.markdown).toContain(
			"file unreadable/unavailable on this host; pointer only",
		);
		expect(bounded.value.markdown).toContain("UNREADABLE_NOTE");
		expect(full.value).not.toContain(
			"file unreadable/unavailable on this host",
		);
	});
	it("rejects malformed/boundary/options/identity cursors and stales relevant content but not excluded changes", async () => {
		const first = await Planner.getContextPage(tracker.home, id, {
			sections: ["description"],
		});
		if (!first.ok || !first.value.nextCursor) return;
		for (const options of [
			{ cursor: "{" },
			{ cursor: first.value.nextCursor, sections: ["discussion"] as const },
			{
				cursor: first.value.nextCursor,
				sections: ["description"] as const,
				deref: false,
			},
		]) {
			const result = await Planner.getContextPage(tracker.home, id, {
				...options,
				sections: options.sections ? [...options.sections] : undefined,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain("cursor");
		}
		const decoded = z
			.record(z.unknown())
			.safeParse(JSON.parse(first.value.nextCursor));
		if (!decoded.success) return;
		for (const offset of [
			0,
			999999999,
			first.value.markdown.indexOf("🐛") + 1,
		]) {
			const malformed = await Planner.getContextPage(tracker.home, id, {
				sections: ["description"],
				cursor: JSON.stringify({ ...decoded.data, offset }),
			});
			expect(malformed.ok).toBe(false);
		}
		const other = tracker.ids[0];
		if (other)
			expect(
				(
					await Planner.getContextPage(tracker.home, other, {
						sections: ["description"],
						cursor: first.value.nextCursor,
					})
				).ok,
			).toBe(false);
		if (other)
			expect(
				(
					await Planner.updateTask(tracker.home, other, {
						description: "UNRELATED_CHANGED",
					})
				).ok,
			).toBe(true);
		expect(
			(
				await Planner.getContextPage(tracker.home, id, {
					sections: ["description"],
					cursor: first.value.nextCursor,
				})
			).ok,
		).toBe(true);
		expect(
			(
				await Planner.addComment(tracker.home, {
					taskId: id,
					content: "EXCLUDED_CHANGED",
					author: "human",
					authorType: "human",
				})
			).ok,
		).toBe(true);
		expect(
			(
				await Planner.getContextPage(tracker.home, id, {
					sections: ["description"],
					cursor: first.value.nextCursor,
				})
			).ok,
		).toBe(true);
		expect(
			(await Planner.updateTask(tracker.home, id, { description: "changed" }))
				.ok,
		).toBe(true);
		const stale = await Planner.getContextPage(tracker.home, id, {
			sections: ["description"],
			cursor: first.value.nextCursor,
		});
		expect(stale.ok).toBe(false);
		if (!stale.ok)
			expect(stale.error.message).toContain("Stale context cursor");
	});
	for (const source of [
		"comments",
		"logs",
		"refs",
		"activities",
		"neighbor",
		"file",
	] as const)
		it(`invalidates actual selected rendered ${source} changes independent of task.version`, async () => {
			let neighborId: string | undefined;
			if (source === "neighbor") {
				const neighbor = await Planner.addTask(tracker.home, {
					title: "Neighbor",
				});
				if (!neighbor.ok) return;
				neighborId = neighbor.value.id;
				expect(
					(
						await Planner.addLink(tracker.home, {
							sourceId: neighborId,
							targetId: id,
							type: "blocks",
						})
					).ok,
				).toBe(true);
			}
			const file = join(tracker.root, "cursor-file");
			if (source === "file") {
				writeFileSync(file, "BEFORE");
				expect(
					(
						await Planner.addContextRef(tracker.home, {
							taskId: id,
							kind: "file",
							uri: `file:${file}`,
						})
					).ok,
				).toBe(true);
			}
			const before = await Planner.getTask(tracker.home, id);
			const first = await Planner.getContextPage(tracker.home, id);
			if (!first.ok || !first.value.nextCursor || !before.ok) return;
			if (source === "comments")
				expect(
					(
						await Planner.addComment(tracker.home, {
							taskId: id,
							author: "human",
							authorType: "human",
							content: "NEW_HUMAN",
						})
					).ok,
				).toBe(true);
			if (source === "logs")
				expect(
					(
						await Planner.addWorkLog(tracker.home, {
							taskId: id,
							refs: [{ uri: "commit:new" }],
							note: "NEW_LOG",
						})
					).ok,
				).toBe(true);
			if (source === "refs")
				expect(
					(
						await Planner.addContextRef(tracker.home, {
							taskId: id,
							kind: "url",
							uri: "https://example.test/new",
							note: "NEW_NOTE",
						})
					).ok,
				).toBe(true);
			if (source === "activities") {
				const session = await Planner.startSession(tracker.home, {
					taskId: id,
					agent: "new-session",
				});
				if (!session.ok) return;
				expect(
					(
						await Planner.addActivity(tracker.home, {
							sessionId: session.value.id,
							type: "decision",
							body: "NEW_DECISION",
						})
					).ok,
				).toBe(true);
			}
			if (source === "neighbor" && neighborId)
				expect(
					(
						await Planner.updateTask(tracker.home, neighborId, {
							title: "Changed neighbor",
						})
					).ok,
				).toBe(true);
			if (source === "file") writeFileSync(file, "AFTER");
			const after = await Planner.getTask(tracker.home, id);
			if (after.ok) expect(after.value?.version).toBe(before.value?.version);
			const stale = await Planner.getContextPage(tracker.home, id, {
				cursor: first.value.nextCursor,
			});
			expect(stale.ok).toBe(false);
			if (!stale.ok) expect(stale.error.message).toContain("Stale");
		});
	for (const source of [
		"task_comments",
		"task_work_log",
		"task_context_refs",
		"agent_sessions",
		"agent_activities",
		"task_links",
	] as const)
		it(`selected ${source} failure cannot claim completeness; excluded sources do not block`, async () => {
			expect(
				(await withDb(tracker.home, (db) => db.exec(`DROP TABLE ${source}`)))
					.ok,
			).toBe(true);
			const selected =
				source === "task_comments" || source.startsWith("agent_")
					? "discussion"
					: source === "task_work_log"
						? "priorWork"
						: source === "task_context_refs"
							? "context"
							: "position";
			const failed = await Planner.getContextPage(tracker.home, id, {
				sections: [selected],
			});
			expect(failed.ok).toBe(false);
			if (!failed.ok)
				expect(failed.error.message).toContain("Cannot read context");
			const unrelated = await Planner.getContextPage(tracker.home, id, {
				sections: ["metadata"],
			});
			expect(unrelated.ok).toBe(true);
			if (unrelated.ok)
				expect(unrelated.value.completeness.humanSteeringComplete).toBe(false);
			expect(
				(await Planner.assembleContext(tracker.home, id, { deref: false })).ok,
			).toBe(true);
		});
	it("many sessions/logs preserve all human chronology, bound durable machine history, tolerate folded noise", async () => {
		for (let index = 0; index < 25; index++) {
			expect(
				(
					await Planner.addComment(tracker.home, {
						taskId: id,
						author: "human",
						authorType: "human",
						content: `HUMAN_${index}`,
					})
				).ok,
			).toBe(true);
			expect(
				(
					await Planner.addWorkLog(tracker.home, {
						taskId: id,
						refs: [{ uri: `commit:${index}` }],
						note: `LOG_${index}`,
					})
				).ok,
			).toBe(true);
			const session = await Planner.startSession(tracker.home, {
				taskId: id,
				agent: `agent_${index}`,
			});
			if (!session.ok) return;
			expect(
				(
					await Planner.addActivity(tracker.home, {
						sessionId: session.value.id,
						type: "decision",
						body: `DECISION_${index}`,
					})
				).ok,
			).toBe(true);
			expect(
				(
					await Planner.addActivity(tracker.home, {
						sessionId: session.value.id,
						type: "progress",
						body: `NOISE_${index}`,
					})
				).ok,
			).toBe(true);
		}
		const result = await collect();
		if (!result.ok) return;
		let previous = -1;
		for (let index = 0; index < 25; index++) {
			const at = result.value.markdown.indexOf(`HUMAN_${index}\n`);
			// Final entries need not have a following newline.
			const position =
				at === -1 ? result.value.markdown.indexOf(`HUMAN_${index}`) : at;
			expect(position).toBeGreaterThan(previous);
			previous = position;
			expect(result.value.markdown).toContain(`LOG_${index}`);
		}
		expect(
			result.value.markdown.match(/\*\*[^\n]+\*\* \(decision,/g),
		).toHaveLength(20);
		expect(result.value.markdown).not.toContain("NOISE_");
		const first = await Planner.getContextPage(tracker.home, id, {
			sections: ["discussion"],
		});
		if (!first.ok || !first.value.nextCursor) return;
		const sessions = await Planner.querySessions(tracker.home, { taskId: id });
		if (!sessions.ok || !sessions.value[0]) return;
		expect(
			(
				await Planner.addActivity(tracker.home, {
					sessionId: sessions.value[0].id,
					type: "progress",
					body: "MORE_FOLDED_NOISE",
				})
			).ok,
		).toBe(true);
		expect(
			(
				await Planner.getContextPage(tracker.home, id, {
					sections: ["discussion"],
					cursor: first.value.nextCursor,
				})
			).ok,
		).toBe(true);
	});
	it("neighbor errors are required for selected position, unlike full legacy fallback", async () => {
		const neighbor = await Planner.addTask(tracker.home, { title: "Neighbor" });
		if (!neighbor.ok) return;
		expect(
			(
				await Planner.addLink(tracker.home, {
					sourceId: neighbor.value.id,
					targetId: id,
					type: "blocks",
				})
			).ok,
		).toBe(true);
		const provider = SqliteDb.provider();
		let reads = 0;
		const failing: DbProvider = {
			withDb: (path, fn) =>
				++reads === 4
					? Promise.resolve(err(new Error("injected neighbor failure")))
					: provider.withDb(path, fn),
		};
		Runtime.configure({ provider: failing });
		const result = await Planner.getContextPage(tracker.home, id, {
			sections: ["position"],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("neighbors");
	});
	it("does not truncate irreducible imported identity and fails within budget without writes", async () => {
		const task = await Planner.addTask(tracker.home, { title: "Imported" });
		if (!task.ok) return;
		const huge = "X".repeat(20000);
		expect(
			(
				await withDb(tracker.home, (db) =>
					db.run(`UPDATE ${TABLES.tasks} SET id = ? WHERE id = ?`, [
						huge,
						task.value.id,
					]),
				)
			).ok,
		).toBe(true);
		const result = await Planner.getContextPage(tracker.home, huge);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message.length).toBeLessThan(200);
			expect(result.error.message).toContain("identity/envelope");
		}
		const full = await Planner.assembleContext(tracker.home, huge);
		expect(full.ok).toBe(true);
	});
});
