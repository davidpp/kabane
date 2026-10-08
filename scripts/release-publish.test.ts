import { expect, test } from "bun:test";
import { err, ok } from "../packages/core/result";
import type { ReleaseManifest } from "./release-artifact";
import {
	authorizePublication,
	completeRelease,
	type PublishOperations,
	type RegistryState,
	type ReleaseState,
} from "./release-publish";

const record: ReleaseManifest = {
	version: "1.2.3",
	tag: "v1.2.3",
	commit: "a".repeat(40),
	dirty: false,
	filename: "kabane-1.2.3.tgz",
	sha256: "b".repeat(64),
	integrity: "sha512-Zml4dHVyZQ==",
	notesSha256: "c".repeat(64),
	bun: "1.4.0",
	npm: "12.2.0",
};
const mockPublication = () => {
	const writes: string[] = [];
	let registry: RegistryState = { existingIntegrity: null, latest: "1.2.2" };
	let release: ReleaseState = null;
	const ops: PublishOperations = {
		verifyTag: async () => ok(undefined),
		registry: async () => ok(registry),
		release: async () => ok(release),
		prepareDraft: async () => {
			writes.push("draft");
			release = {
				draft: true,
				immutable: false,
				assetsMatch: true,
				assetsComplete: true,
			};
			return ok(undefined);
		},
		publishArchive: async () => {
			writes.push("publish-once");
			registry = {
				existingIntegrity: record.integrity,
				latest: record.version,
			};
			return ok(undefined);
		},
		finalizeDraft: async () => {
			writes.push("finalize");
			release = {
				draft: false,
				immutable: true,
				assetsMatch: true,
				assetsComplete: true,
			};
			return ok(undefined);
		},
	};
	return {
		ops,
		writes,
		setRegistry: (value: RegistryState): void => {
			registry = value;
		},
		setRelease: (value: ReleaseState): void => {
			release = value;
		},
	};
};
test("fresh publication prepares verified assets, publishes once, then freezes GitHub", async () => {
	const fixture = mockPublication();
	expect((await completeRelease(record, fixture.ops)).ok).toBe(true);
	expect(fixture.writes).toEqual(["draft", "publish-once", "finalize"]);
});
test("already identical immutable release is read-only; matching npm partial state resumes GitHub only", async () => {
	for (const complete of [false, true]) {
		const fixture = mockPublication();
		fixture.setRegistry({
			existingIntegrity: record.integrity,
			latest: record.version,
		});
		if (complete)
			fixture.setRelease({
				draft: false,
				immutable: true,
				assetsMatch: true,
				assetsComplete: true,
			});
		expect((await completeRelease(record, fixture.ops)).ok).toBe(true);
		expect(fixture.writes).toEqual(complete ? [] : ["draft", "finalize"]);
	}
});
test("version/hash/latest/tag/source conflicts fail before irreversible operations", async () => {
	for (const state of [
		{ existingIntegrity: "different", latest: record.version },
		{ existingIntegrity: null, latest: record.version },
		{ existingIntegrity: null, latest: "2.0.0" },
	]) {
		const fixture = mockPublication();
		fixture.setRegistry(state);
		expect((await completeRelease(record, fixture.ops)).ok).toBe(false);
		expect(fixture.writes).toEqual([]);
	}
	for (const bad of [
		{ ...record, dirty: true },
		{ ...record, tag: null },
		{ ...record, tag: "v1.2.4" },
	]) {
		const fixture = mockPublication();
		expect((await completeRelease(bad, fixture.ops)).ok).toBe(false);
		expect(fixture.writes).toEqual([]);
	}
	const missing = mockPublication();
	missing.ops.verifyTag = async () => err(new Error("missing remote tag"));
	expect((await completeRelease(record, missing.ops)).ok).toBe(false);
	expect(missing.writes).toEqual([]);
});
test("conflicting or incomplete draft assets cannot authorize npm publication", async () => {
	const conflict = mockPublication();
	conflict.setRelease({
		draft: true,
		immutable: false,
		assetsMatch: false,
		assetsComplete: false,
	});
	expect((await completeRelease(record, conflict.ops)).ok).toBe(false);
	expect(conflict.writes).toEqual([]);
	const incomplete = mockPublication();
	incomplete.ops.prepareDraft = async () => {
		incomplete.setRelease({
			draft: true,
			immutable: false,
			assetsMatch: true,
			assetsComplete: false,
		});
		return ok(undefined);
	};
	expect((await completeRelease(record, incomplete.ops)).ok).toBe(false);
	expect(incomplete.writes).toEqual([]);
});
test("publisher error after a committed write is reconciled by readback, never a second publish", async () => {
	const fixture = mockPublication();
	fixture.ops.publishArchive = async () => {
		fixture.writes.push("ambiguous-publish");
		fixture.setRegistry({
			existingIntegrity: record.integrity,
			latest: record.version,
		});
		return err(new Error("connection lost"));
	};
	expect((await completeRelease(record, fixture.ops)).ok).toBe(true);
	expect(fixture.writes).toEqual(["draft", "ambiguous-publish", "finalize"]);
});
test("unconfirmed publisher failure stops at a retained draft with no blind retry", async () => {
	const fixture = mockPublication();
	fixture.ops.publishArchive = async () => {
		fixture.writes.push("failed-publish");
		return err(new Error("OIDC/permission failure"));
	};
	const result = await completeRelease(record, fixture.ops);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.message).toContain("unverified/partial");
	expect(fixture.writes).toEqual(["draft", "failed-publish"]);
});
test("npm success followed by GitHub failure reports recoverable partial state", async () => {
	const fixture = mockPublication();
	fixture.ops.finalizeDraft = async () => err(new Error("GitHub denied"));
	const result = await completeRelease(record, fixture.ops);
	expect(result.ok).toBe(false);
	if (!result.ok)
		expect(result.error.message).toContain("never rebuild or republish");
	expect(fixture.writes).toEqual(["draft", "publish-once"]);
	expect(
		(
			await completeRelease(record, {
				...fixture.ops,
				finalizeDraft: async () => {
					fixture.setRelease({
						draft: false,
						immutable: true,
						assetsMatch: true,
						assetsComplete: true,
					});
					return ok(undefined);
				},
			})
		).ok,
	).toBe(true);
	expect(
		fixture.writes.filter((write) => write === "publish-once"),
	).toHaveLength(1);
});
test("publication guard requires human-job context/OIDC/setup and forbids credential fallback", () => {
	const env = {
		GITHUB_ACTIONS: "true",
		GITHUB_REPOSITORY: "davidpp/kabane",
		GITHUB_SHA: record.commit,
		GITHUB_REF: "refs/tags/v1.2.3",
		RELEASE_PUBLISH: "true",
		RELEASE_SETUP_CONFIRMED: "true",
		GH_TOKEN: "fixture-only",
		ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-only",
		ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/fixture",
	};
	expect(authorizePublication(record, {}).ok).toBe(false);
	expect(authorizePublication(record, env).ok).toBe(true);
	for (const altered of [
		{ ...env, GITHUB_REF: "refs/heads/main" },
		{ ...env, GITHUB_SHA: "b".repeat(40) },
		{ ...env, RELEASE_SETUP_CONFIRMED: "" },
		{ ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" },
		{ ...env, NODE_AUTH_TOKEN: "fixture-secret" },
	])
		expect(authorizePublication(record, altered).ok).toBe(false);
});
