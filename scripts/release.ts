import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runUpdateProcess } from "../packages/cli/src/update-process";
import { err, ok, type Result } from "../packages/core/result";
import {
	ReleaseManifestSchema,
	sha256,
	verifyReleaseFiles,
} from "./release-artifact";
import { publishRelease } from "./release-publish";

const ROOT = resolve(import.meta.dir, "..");
const command = async (argv: string[], cwd = ROOT): Promise<Result<string>> => {
	const result = await runUpdateProcess(argv, cwd, process.env, 120_000);
	return result.ok && result.value.code === 0
		? ok(result.value.stdout.trim())
		: err(
				new Error(
					"Release verification command failed; inspect the named stage manually.",
				),
			);
};

const verifySource = async (
	root: string,
	ref?: string,
	expectedCommit?: string,
) => {
	const source = z
		.object({ name: z.literal("kabane"), version: z.string() })
		.safeParse(
			JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")),
		);
	if (!source.success) return err(new Error("Invalid source CLI manifest."));
	const commit = await command(["git", "rev-parse", "HEAD"], root);
	const status = await command(["git", "status", "--porcelain"], root);
	if (!commit.ok || !status.ok)
		return err(new Error("Could not establish source identity."));
	if (expectedCommit && commit.value !== expectedCommit)
		return err(new Error("Checkout/event commit mismatch."));
	const tag = ref?.startsWith("refs/tags/")
		? ref.slice("refs/tags/".length)
		: null;
	if (tag !== null && tag !== `v${source.data.version}`)
		return err(new Error("Tag/source version mismatch."));
	return ok({
		version: source.data.version,
		commit: commit.value,
		dirty: status.value !== "",
		tag,
	});
};

/**
 * The release's identity and notes, before the native jobs' archives are attached
 * (`release-binaries.ts`). Nothing is built here: the archives are the whole release.
 */
export const prepareRelease = async (
	output: string,
	ref?: string,
	expectedCommit?: string,
	notes?: string,
	root = ROOT,
): Promise<Result<string>> => {
	try {
		const source = await verifySource(root, ref, expectedCommit);
		if (!source.ok) return source;
		const { version, commit, dirty, tag } = source.value;
		const body =
			notes?.trim() ||
			`# kabane ${version}\n\nSource commit: ${commit}\n\nReview compatibility, consistent database backups, restart/rewiring instructions and the manual terminal smoke before publishing.\n`;
		if (Buffer.byteLength(body) > 32_768)
			return err(new Error("Release notes exceed 32KiB."));
		const noteBytes = Buffer.from(`${body}\n`);
		const manifest = ReleaseManifestSchema.safeParse({
			version,
			commit,
			tag,
			dirty,
			notesSha256: sha256(noteBytes),
			bun: Bun.version,
		});
		if (!manifest.success)
			return err(new Error("Invalid release identity/tool metadata."));
		mkdirSync(output);
		writeFileSync(
			join(output, "manifest.json"),
			`${JSON.stringify(manifest.data, null, 2)}\n`,
		);
		writeFileSync(join(output, "release-notes.md"), noteBytes);
		const checked = verifyReleaseFiles(output);
		return checked.ok
			? ok(
					`Prepared release ${version}; tag=${tag ?? "none"}, dirty=${manifest.data.dirty}. The native archives attach next.`,
				)
			: checked;
	} catch {
		return err(
			new Error(
				"Release preparation failed; preserve output for inspection, do not rebuild a recovery artifact.",
			),
		);
	}
};

if (import.meta.main) {
	const [mode, directory, ...extra] = process.argv.slice(2);
	let result: Result<string>;
	if (!directory || extra.length)
		result = err(
			new Error(
				"Usage: bun scripts/release.ts prepare|verify|publish <artifact-directory>",
			),
		);
	else if (
		mode === "prepare" &&
		process.env.RELEASE_PUBLISH === "true" &&
		(process.env.GITHUB_REF_TYPE !== "tag" ||
			process.env.GITHUB_REPOSITORY !== "davidpp/kabane")
	)
		result = err(
			new Error(
				"Publish dispatch must use an existing tag ref in davidpp/kabane; branch verification is nonpromotable.",
			),
		);
	else if (mode === "prepare")
		result = await prepareRelease(
			resolve(directory),
			process.env.GITHUB_REF,
			process.env.GITHUB_SHA,
			process.env.RELEASE_NOTES,
		);
	else if (mode === "verify") {
		const verified = verifyReleaseFiles(resolve(directory));
		result = verified.ok
			? ok(
					`Artifact hashes verified for ${verified.value.version}; nothing published.`,
				)
			: verified;
	} else if (mode === "publish")
		result = await publishRelease(resolve(directory), process.env);
	else result = err(new Error("Unknown release mode; no operation performed."));
	if (result.ok) console.log(result.value);
	else {
		console.error(result.error.message);
		process.exitCode = 1;
	}
}
