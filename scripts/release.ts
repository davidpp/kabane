import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runUpdateProcess } from "../packages/cli/src/update-process";
import { err, ok, type Result } from "../packages/core/result";
import {
	inspectArchive,
	integrity,
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

export const prepareRelease = async (
	output: string,
	ref?: string,
	expectedCommit?: string,
	notes?: string,
): Promise<Result<string>> => {
	try {
		const source = z
			.object({ name: z.literal("kabane"), version: z.string() })
			.safeParse(
				JSON.parse(
					readFileSync(join(ROOT, "packages/cli/package.json"), "utf8"),
				),
			);
		if (!source.success) return err(new Error("Invalid source CLI manifest."));
		const commit = await command(["git", "rev-parse", "HEAD"]);
		const status = await command(["git", "status", "--porcelain"]);
		const npm = await command(["npm", "--version"]);
		if (!commit.ok || !status.ok || !npm.ok)
			return err(new Error("Could not establish source/tool identity."));
		if (expectedCommit && commit.value !== expectedCommit)
			return err(new Error("Checkout/event commit mismatch."));
		const tag = ref?.startsWith("refs/tags/")
			? ref.slice("refs/tags/".length)
			: null;
		if (tag !== null && tag !== `v${source.data.version}`)
			return err(new Error("Tag/source version mismatch."));
		const built = await command([process.execPath, "scripts/build.ts"]);
		if (!built.ok) return built;
		mkdirSync(output);
		const packed = await command(
			[
				"npm",
				"pack",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				output,
			],
			join(ROOT, "packages/cli/dist"),
		);
		if (!packed.ok) return packed;
		const pack = z
			.array(
				z.object({ filename: z.string().regex(/^kabane-\d+\.\d+\.\d+\.tgz$/) }),
			)
			.length(1)
			.safeParse(JSON.parse(packed.value));
		const first = pack.success ? pack.data[0] : undefined;
		if (!first) return err(new Error("Invalid pack result."));
		const archive = join(output, first.filename);
		const inspected = await inspectArchive(
			archive,
			join(output, "inspection"),
			[ROOT, homedir()],
		);
		if (!inspected.ok || inspected.value.version !== source.data.version)
			return err(
				new Error("Packed/source version or artifact inspection failed."),
			);
		const bytes = readFileSync(archive);
		const body =
			notes?.trim() ||
			`# kabane ${source.data.version}\n\nSource commit: ${commit.value}\n\nReview compatibility, consistent database backups, restart/rewiring instructions and the manual terminal smoke before publishing.\n`;
		if (Buffer.byteLength(body) > 32_768)
			return err(new Error("Release notes exceed 32KiB."));
		const noteBytes = Buffer.from(`${body}\n`);
		const manifest = ReleaseManifestSchema.safeParse({
			version: source.data.version,
			commit: commit.value,
			tag,
			dirty: status.value !== "",
			filename: first.filename,
			sha256: sha256(bytes),
			integrity: integrity(bytes),
			notesSha256: sha256(noteBytes),
			bun: Bun.version,
			npm: npm.value,
		});
		if (!manifest.success)
			return err(new Error("Invalid release identity/tool metadata."));
		writeFileSync(
			join(output, "manifest.json"),
			`${JSON.stringify(manifest.data, null, 2)}\n`,
		);
		writeFileSync(
			join(output, "SHA256SUMS"),
			`${manifest.data.sha256}  ${first.filename}\n`,
		);
		writeFileSync(join(output, "release-notes.md"), noteBytes);
		const checked = verifyReleaseFiles(output);
		return checked.ok
			? ok(
					`Verified archive ${first.filename}; tag=${tag ?? "none"}, dirty=${manifest.data.dirty}. Nonpublishing preparation does not prove OIDC.`,
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
					`Artifact hashes verified for ${verified.value.version}; no publication/OIDC operation performed.`,
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
