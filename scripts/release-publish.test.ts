import { expect, test } from "bun:test";
import { err, ok } from "../packages/core/result";
import { BinaryTargetSchema, type ReleaseManifest } from "./release-artifact";
import {
	authorizePublication,
	completeRelease,
	finalizeArguments,
	type PublishOperations,
	type ReleaseState,
} from "./release-publish";

const record: ReleaseManifest = {
	version: "1.2.3",
	tag: "v1.2.3",
	commit: "a".repeat(40),
	dirty: false,
	notesSha256: "c".repeat(64),
	bun: "1.4.0",
	binaries: BinaryTargetSchema.options.map((target, index) => ({
		target,
		filename: `kabane-${target}.tar.gz`,
		sha256: String(index + 2).repeat(64),
	})),
	installerSha256: "d".repeat(64),
};
const beta: ReleaseManifest = {
	...record,
	version: "1.2.3-beta.0",
	tag: "v1.2.3-beta.0",
};
const published = (prerelease: boolean): NonNullable<ReleaseState> => ({
	draft: false,
	prerelease,
	immutable: true,
	assetsMatch: true,
	assetsComplete: true,
});

/** GitHub as the state machine sees it: one release for the tag, and the highest published stable. */
const github = (subject = record, highest: string | null = "1.2.2") => {
	const prerelease = subject.version.includes("-");
	const writes: string[] = [];
	let release: ReleaseState = null;
	const ops: PublishOperations = {
		verifyTag: async () => ok(undefined),
		release: async () => ok(release),
		highestStable: async () => ok(highest),
		prepareDraft: async () => {
			writes.push("draft");
			release = { ...published(prerelease), draft: true, immutable: false };
			return ok(undefined);
		},
		finalizeDraft: async () => {
			writes.push("finalize");
			release = published(prerelease);
			return ok(undefined);
		},
	};
	return {
		ops,
		writes,
		setRelease: (value: ReleaseState): void => {
			release = value;
		},
	};
};

test("a fresh stable release is drafted with every asset, read back, then published as latest", async () => {
	const fixture = github();
	expect(await completeRelease(record, fixture.ops)).toEqual({
		ok: true,
		value: "Verified immutable GitHub release, now the latest.",
	});
	expect(fixture.writes).toEqual(["draft", "finalize"]);
	expect(finalizeArguments(record).slice(-2)).toEqual([
		"--draft=false",
		"--latest",
	]);
});

test("a beta completes as a prerelease that never becomes latest", async () => {
	const fixture = github(beta);
	expect(await completeRelease(beta, fixture.ops)).toEqual({
		ok: true,
		value: "Verified immutable GitHub prerelease.",
	});
	expect(fixture.writes).toEqual(["draft", "finalize"]);
	expect(finalizeArguments(beta).slice(-3)).toEqual([
		"--draft=false",
		"--prerelease",
		"--latest=false",
	]);
	// A finalized beta that GitHub shows as an ordinary release is not verified.
	const unmarked = github(beta);
	unmarked.ops.finalizeDraft = async () => {
		unmarked.setRelease(published(false));
		return ok(undefined);
	};
	expect((await completeRelease(beta, unmarked.ops)).ok).toBe(false);
});

test("a failed gh write reaches the job log with gh's own error", async () => {
	const finalize = github();
	finalize.ops.finalizeDraft = async () =>
		err(new Error("gh release edit exited 1: HTTP 422: Validation Failed"));
	const finalized = await completeRelease(record, finalize.ops);
	expect(finalized.ok).toBe(false);
	if (!finalized.ok)
		expect(finalized.error.message).toBe(
			"GitHub finalization failed. Inspect the draft; resume from the original matching bytes, never rebuild.\ngh release edit exited 1: HTTP 422: Validation Failed",
		);
	const draft = github();
	draft.ops.prepareDraft = async () =>
		err(new Error("gh release create: Bun operation timed out."));
	const prepared = await completeRelease(record, draft.ops);
	expect(prepared.ok).toBe(false);
	if (!prepared.ok)
		expect(prepared.error.message).toContain(
			"\ngh release create: Bun operation timed out.",
		);
	// A gh release download that fails while reading a release back is named too.
	const read = github();
	read.ops.release = async () =>
		err(new Error("gh release download exited 1: HTTP 502"));
	const unread = await completeRelease(record, read.ops);
	expect(unread.ok).toBe(false);
	if (!unread.ok)
		expect(unread.error.message).toBe(
			"Cannot establish GitHub release state; nothing published.\ngh release download exited 1: HTTP 502",
		);
});

test("the first stable release needs no published one before it", async () => {
	const fixture = github(record, null);
	expect((await completeRelease(record, fixture.ops)).ok).toBe(true);
	expect(fixture.writes).toEqual(["draft", "finalize"]);
});

test("an identical immutable release is read-only; a matching draft resumes", async () => {
	const complete = github();
	complete.setRelease(published(false));
	expect(await completeRelease(record, complete.ops)).toEqual({
		ok: true,
		value: "Verified already complete; no writes performed.",
	});
	expect(complete.writes).toEqual([]);
	const draft = github();
	draft.setRelease({ ...published(false), draft: true, immutable: false });
	expect((await completeRelease(record, draft.ops)).ok).toBe(true);
	expect(draft.writes).toEqual(["draft", "finalize"]);
});

test("conflicting, mutable or mismarked releases fail before any write", async () => {
	for (const state of [
		{ ...published(false), assetsMatch: false },
		{ ...published(false), immutable: false },
		{ ...published(false), assetsComplete: false },
		published(true),
		{ ...published(false), draft: true, assetsMatch: false },
	]) {
		const fixture = github();
		fixture.setRelease(state);
		expect((await completeRelease(record, fixture.ops)).ok).toBe(false);
		expect(fixture.writes).toEqual([]);
	}
});

test("a release that does not pass the highest published stable is never drafted", async () => {
	for (const [subject, highest] of [
		[record, "1.2.3"],
		[record, "1.10.0"],
		[beta, "1.2.3"],
	] as const) {
		const fixture = github(subject, highest);
		expect((await completeRelease(subject, fixture.ops)).ok).toBe(false);
		expect(fixture.writes).toEqual([]);
	}
	const unreadable = github();
	unreadable.ops.highestStable = async () => err(new Error("offline"));
	expect((await completeRelease(record, unreadable.ops)).ok).toBe(false);
	expect(unreadable.writes).toEqual([]);
});

test("a dirty, untagged or binary-less artifact is nonpromotable", async () => {
	for (const subject of [
		{ ...record, dirty: true },
		{ ...record, tag: null },
		{ ...record, tag: "v1.2.4" },
		{ ...record, binaries: undefined, installerSha256: undefined },
	]) {
		const fixture = github();
		expect((await completeRelease(subject, fixture.ops)).ok).toBe(false);
		expect(fixture.writes).toEqual([]);
	}
});

test("an unverified draft or a moved tag stops before finalization", async () => {
	const partial = github();
	partial.ops.prepareDraft = async () => {
		partial.writes.push("draft");
		partial.setRelease({
			...published(false),
			draft: true,
			immutable: false,
			assetsComplete: false,
		});
		return ok(undefined);
	};
	expect((await completeRelease(record, partial.ops)).ok).toBe(false);
	expect(partial.writes).toEqual(["draft"]);
	const moved = github();
	let checks = 0;
	moved.ops.verifyTag = async () =>
		++checks > 1 ? err(new Error("moved")) : ok(undefined);
	expect((await completeRelease(record, moved.ops)).ok).toBe(false);
	expect(moved.writes).toEqual(["draft"]);
	const mutable = github();
	mutable.ops.finalizeDraft = async () => {
		mutable.writes.push("finalize");
		mutable.setRelease({ ...published(false), immutable: false });
		return ok(undefined);
	};
	expect((await completeRelease(record, mutable.ops)).ok).toBe(false);
});

test("publication runs only in the approved publish job on a matching tag ref", () => {
	const env = {
		GITHUB_ACTIONS: "true",
		GITHUB_REPOSITORY: "davidpp/kabane",
		GITHUB_SHA: record.commit,
		GITHUB_REF: "refs/tags/v1.2.3",
		RELEASE_PUBLISH: "true",
		GH_TOKEN: "fixture-only",
	};
	expect(authorizePublication(record, {}).ok).toBe(false);
	expect(authorizePublication(record, env).ok).toBe(true);
	for (const altered of [
		{ ...env, GITHUB_ACTIONS: "" },
		{ ...env, GITHUB_REPOSITORY: "fork/kabane" },
		{ ...env, GITHUB_REF: "refs/heads/main" },
		{ ...env, GITHUB_SHA: "b".repeat(40) },
		{ ...env, RELEASE_PUBLISH: "false" },
		{ ...env, GH_TOKEN: "" },
	])
		expect(authorizePublication(record, altered).ok).toBe(false);
});
