import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	KABANE_TOOLS,
	NotFoundError,
	Planner,
	type Result,
	type CoreToolInputShapes,
	TaskLinkSchema,
} from "@kabane/core";
import { configureTestRuntime } from "@kabane/core/testing";
import type { z } from "zod";
import type { Host } from "./host";
import { createHostRecord } from "./host-record";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});
const value = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

it("maps every wrapper to the full tool result in a real database", async () => {
	configureTestRuntime();
	const home = mkdtempSync(join(tmpdir(), "kabane-record-"));
	homes.push(home);
	value(await Planner.init(home));
	const actor = "kabane://actor/agent/host-test";
	const record = createHostRecord(KABANE_TOOLS, {
		basePath: home,
		actor,
		scopeRequired: false,
	});
	const parent = value(
		await Planner.addTask(home, { title: "Parent", kind: "issue" }),
	);
	expect(value(await record.get({ id: parent.id.slice(0, 25) }))).toEqual(
		parent,
	);
	const child = value(
		await Planner.addTask(home, { title: "Child", parentTaskId: parent.id }),
	);
	expect(value(await record.get({ id: parent.id }))).toEqual(parent);
	for (const [id, message] of [
		["missing", "No task found with ID prefix: missing"],
		["JCAB-999999", "No task found with ID: JCAB-999999"],
		["01AAAAAAAAAAAAAAAAAAAAAAAA", "No task found: 01AAAAAAAAAAAAAAAAAAAAAAAA"],
	] as const) {
		expect(value(await record.get({ id }))).toBeNull();
		expect(await record.call("kabane_get", { id })).toMatchObject({
			ok: false,
			error: { name: "NotFoundError", message },
		});
	}
	if (!parent.shortId) throw new Error("Missing short id");
	expect(value(await record.get({ id: parent.shortId.toLowerCase() }))).toEqual(
		parent,
	);
	const ambiguous = await record.get({ id: parent.id.slice(0, 1) });
	expect(ambiguous.ok).toBe(false);
	if (!ambiguous.ok) {
		expect(ambiguous.error).not.toBeInstanceOf(NotFoundError);
		expect(ambiguous.error.message).toContain("Ambiguous ID prefix");
		for (const candidate of [parent, child]) {
			expect(ambiguous.error.message).toContain(
				`${candidate.shortId}  ${candidate.title}`,
			);
		}
	}
	expect(
		value(
			await record.list({ parentTaskId: parent.id, includeDeferred: true }),
		),
	).toEqual([child]);
	expect(
		value(
			await record.edit({
				id: parent.id,
				needsReview: true,
				state: "in_progress",
			}),
		),
	).toMatchObject({ id: parent.id, needsReview: true, state: "in_progress" });
	const commentInput = {
		id: parent.id,
		body: "From host",
		kind: "review",
		text: "ignored alias",
		content: "ignored legacy alias",
	};
	const comment = value(await record.comment(commentInput));
	expect(comment).toMatchObject({
		taskId: parent.id,
		content: "From host",
		author: actor,
		authorType: "ai",
		kind: "review",
	});
	expect(value(await Planner.getEntries(home, parent.id))).toEqual([comment]);
	const log = value(
		await record.log({ id: parent.id, commit: "abc123", note: "Evidence" }),
	);
	expect(log).toMatchObject({
		taskId: parent.id,
		refs: [{ uri: "commit:abc123", addedBy: actor, addedByType: "ai" }],
	});
	expect(value(await record.workLogs({ id: parent.id, limit: 1 }))).toEqual([
		log,
	]);
	const upstream = value(
		await record.upstreamLink({
			id: parent.id,
			provider: "github",
			externalId: "12",
			url: "https://example.com/12",
			title: "Upstream",
		}),
	);
	expect(upstream).toMatchObject({ taskId: parent.id, externalId: "12" });
	expect(value(await record.upstreamLinks({ id: parent.id }))).toEqual([
		upstream,
	]);
	const link = value(
		await record.call("kabane_link", {
			sourceId: parent.id,
			targetId: child.id,
			type: "related",
		}),
	);
	const parsedLink = TaskLinkSchema.safeParse(link);
	if (!parsedLink.success) throw parsedLink.error;
	expect(value(await record.links({ id: parent.id }))).toContainEqual(
		parsedLink.data,
	);
	expect(
		value(await record.context({ id: parent.id, deref: false })),
	).toMatchObject({
		id: parent.id,
		markdown: expect.stringContaining("From host"),
	});
	expect(value(await record.done({ id: parent.id }))).toMatchObject({
		id: parent.id,
		state: "done",
	});
	// JavaScript callers cannot change the named wrappers' full result shape.
	const listInput = {
		responseFormat: "concise",
		cursor: "ignored",
		includeClosed: true,
	};
	expect(value(await record.list(listInput))).toBeArray();
	expect(
		value(await record.call("kabane_list", { responseFormat: "concise" })),
	).not.toBeArray();
	expect((await record.get({ id: "" })).ok).toBe(false);
	expect((await record.workLogs({ id: parent.id, limit: 0 })).ok).toBe(false);
	expect(await record.call("missing", {})).toMatchObject({
		ok: false,
		error: { message: "Unknown tool: missing" },
	});
});

it("refuses every record method before the runtime is configured", async () => {
	const record = createHostRecord(KABANE_TOOLS, () => undefined);
	for (const result of await Promise.all([
		record.get({ id: "x" }),
		record.list({}),
		record.edit({ id: "x" }),
		record.done({ id: "x" }),
		record.comment({ id: "x", body: "x" }),
		record.log({ id: "x", commit: "x" }),
		record.context({ id: "x" }),
		record.upstreamLink({
			id: "x",
			provider: "x",
			externalId: "x",
			url: "https://example.com",
			title: "x",
		}),
		record.links({ id: "x" }),
		record.upstreamLinks({ id: "x" }),
		record.workLogs({ id: "x" }),
		record.call("kabane_get", { id: "x" }),
	]))
		expect(result).toMatchObject({
			ok: false,
			error: {
				message:
					"the runtime is not configured yet for this host; call record after the factory returns and the store opens (standalone commands do not open it automatically)",
			},
		});
});

// The tool schema is the source of truth; these assertions compile in the package gate.
type Input<K extends keyof CoreToolInputShapes> = Omit<
	z.input<z.ZodObject<CoreToolInputShapes[K]>>,
	"responseFormat" | "cursor"
>;
type NamedInputs = {
	get: Input<"get">;
	list: Omit<Input<"list">, "attribute">; // Column projection belongs to concise pages.
	edit: Input<"edit">;
	done: Input<"done">;
	// The wrapper requires body because it removes the two alternative spellings.
	comment: Omit<Input<"comment">, "text" | "content" | "body"> &
		Required<Pick<Input<"comment">, "body">>;
	log: Input<"workLog">;
	// Sections select concise output, which the full-format wrapper does not expose.
	context: Omit<Input<"context">, "sections">;
	upstreamLink: Input<"upstreamLink">;
	links: Input<"linkList">;
	upstreamLinks: Input<"upstreamList">;
	workLogs: Input<"logList">;
};
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
type Flatten<T> = { [K in keyof T]: T[K] };
type InputParity = {
	[K in keyof NamedInputs]: Equal<
		Flatten<Parameters<Host.Record[K]>[0]>,
		Flatten<NamedInputs[K]>
	>;
};

it("holds every named wrapper input equal to its tool schema", () => {
	const parity: InputParity = {
		get: true,
		list: true,
		edit: true,
		done: true,
		comment: true,
		log: true,
		context: true,
		upstreamLink: true,
		links: true,
		upstreamLinks: true,
		workLogs: true,
	};
	expect(Object.values(parity).every(Boolean)).toBe(true);
});

it("pages full records through the tool and named wrapper", async () => {
	configureTestRuntime();
	const home = mkdtempSync(join(tmpdir(), "kabane-pages-"));
	homes.push(home);
	value(await Planner.init(home));
	const record = createHostRecord(KABANE_TOOLS, {
		basePath: home,
		actor: "kabane://actor/agent/test",
		scopeRequired: false,
	});
	for (let i = 0; i < 5; i++) {
		value(await Planner.addTask(home, { title: `Page ${i}` }));
		await Bun.sleep(2);
	}
	const all = value(await record.list({}));
	for (const offset of [0, 2, 4]) {
		const expected = all.slice(offset, offset + 2);
		expect(value(await record.list({ limit: 2, offset }))).toEqual(expected);
		expect(
			value(await record.call("kabane_list", { limit: 2, offset })),
		).toEqual(expected);
	}
	expect(
		await record.call("kabane_list", { responseFormat: "concise", offset: 0 }),
	).toMatchObject({
		ok: false,
		error: {
			message: "concise pages with cursor; offset requires full format.",
		},
	});
	for (const offset of [-1, 0.5])
		expect((await record.call("kabane_list", { offset })).ok).toBe(false);
});

it("preserves a real database read failure", async () => {
	configureTestRuntime();
	const home = mkdtempSync(join(tmpdir(), "kabane-unmigrated-"));
	homes.push(home);
	const record = createHostRecord(KABANE_TOOLS, {
		basePath: home,
		actor: "kabane://actor/agent/test",
		scopeRequired: false,
	});
	const result = await record.get({ id: "missing" });
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.message).toContain("no such table");
});
