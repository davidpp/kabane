import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	KABANE_TOOLS,
	Planner,
	type Result,
	TaskLinkSchema,
} from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
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
	const actor = "cabane://actor/agent/host-test";
	const record = createHostRecord(KABANE_TOOLS, {
		basePath: home,
		actor,
		scopeRequired: false,
	});
	const parent = value(
		await Planner.addTask(home, { title: "Parent", kind: "issue" }),
	);
	const child = value(
		await Planner.addTask(home, { title: "Child", parentTaskId: parent.id }),
	);
	expect(value(await record.get({ id: parent.id }))).toEqual(parent);
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
	const comment = value(
		await record.comment({ id: parent.id, body: "From host", kind: "review" }),
	);
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
	expect(
		value(
			await record.call("kabane_list", {
				responseFormat: "concise",
				cursor: "ignored",
				includeClosed: true,
			}),
		),
	).toBeArray();
	expect((await record.get({ id: "" })).ok).toBe(false);
	expect(
		(await record.context({ id: parent.id, sections: ["description"] })).ok,
	).toBe(false);
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
					"the runtime is not configured yet; call it from a command, a board port or a tool handler, not from the factory",
			},
		});
});
