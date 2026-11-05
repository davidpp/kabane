import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { runUpdateProcess } from "../packages/cli/src/update-process";
import { ChannelVersionSchema } from "../packages/cli/src/update-version";
import { err, ok, type Result } from "../packages/core/result";

/** An exact stable pin: the tools and externals a release records. */
export const ReleaseVersionSchema = z
	.string()
	.max(64)
	.regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
/** The archive `npm pack` names for a stable or beta kabane. */
export const ReleaseFilenameSchema = z
	.string()
	.regex(/^kabane-\d+\.\d+\.\d+(?:-beta\.\d+)?\.tgz$/);
export const PublishManifestSchema = z
	.object({
		name: z.literal("kabane"),
		version: ChannelVersionSchema,
		private: z.literal(false).optional(),
		type: z.literal("module"),
		bin: z.object({ kabane: z.literal("bin/kabane.js") }),
		engines: z.object({ bun: z.string().regex(/^>=\d+\.\d+\.\d+$/) }),
		repository: z.object({
			type: z.literal("git"),
			url: z.literal("git+https://github.com/davidpp/kabane.git"),
		}),
		dependencies: z
			.object({
				"@opentui/core": ReleaseVersionSchema,
				"@opentui/react": ReleaseVersionSchema,
				react: ReleaseVersionSchema,
			})
			.strict(),
	})
	.passthrough();
export const BinaryTargetSchema = z.enum([
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
]);
export const BinaryArtifactSchema = z
	.object({
		target: BinaryTargetSchema,
		filename: z.string(),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict()
	.refine((value) => value.filename === `kabane-${value.target}.tar.gz`);
export const releaseChecksums = (record: ReleaseManifest): string =>
	`${record.sha256}  ${record.filename}\n` +
	(record.binaries ?? [])
		.map((binary) => `${binary.sha256}  ${binary.filename}\n`)
		.join("");
export const ReleaseManifestSchema = z
	.object({
		version: ChannelVersionSchema,
		commit: z.string().regex(/^[a-f0-9]{40}$/),
		tag: z
			.string()
			.regex(/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/)
			.nullable(),
		dirty: z.boolean(),
		filename: ReleaseFilenameSchema,
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
		binaries: z
			.array(BinaryArtifactSchema)
			.length(4)
			.refine((items) => new Set(items.map((item) => item.target)).size === 4)
			.optional(),
		notesSha256: z.string().regex(/^[a-f0-9]{64}$/),
		bun: ReleaseVersionSchema,
		npm: ReleaseVersionSchema,
	})
	.strict();
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
export const sha256 = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");
export const integrity = (bytes: Uint8Array): string =>
	`sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const readArtifactFile = (
	file: string,
	limit = 16_777_216,
): Result<Buffer> => {
	try {
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > limit)
			return err(new Error("Missing, nonregular or oversized artifact file."));
		return ok(readFileSync(file));
	} catch {
		return err(new Error("Could not read artifact file."));
	}
};

const verifyTarHeaders = (bytes: Buffer): Result<void> => {
	// Bound expansion before an external extractor can write files. The package uses
	// ordinary ustar files/directories, not sparse/PAX/link extensions.
	const tar = gunzipSync(bytes, { maxOutputLength: 33_554_432 });
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const type = header[156];
		const sizeText = header
			.subarray(124, 136)
			.toString("ascii")
			.replace(/\0.*$/, "")
			.trim();
		if (![0, 48, 53].includes(type ?? -1) || !/^[0-7]+$/.test(sizeText))
			return err(new Error("Unsupported archive extension or size encoding."));
		const size = Number.parseInt(sizeText, 8);
		if (size > 16_777_216 || offset + 512 + size > tar.length)
			return err(new Error("Oversized or truncated archive member."));
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return ok(undefined);
};

const inspectExtractedPackage = (
	unpacked: string,
	forbiddenPaths: string[],
): Result<z.infer<typeof PublishManifestSchema>> => {
	const files = readdirSync(join(unpacked, "package"), {
		recursive: true,
		withFileTypes: true,
	})
		.filter((file) => file.isFile())
		.map((file) => join(file.parentPath, file.name));
	let total = 0;
	for (const file of files) {
		const content = readArtifactFile(file);
		if (!content.ok) return content;
		total += content.value.byteLength;
		if (
			total > 33_554_432 ||
			file.endsWith(".map") ||
			forbiddenPaths.some(
				(path) => path && content.value.toString().includes(path),
			)
		)
			return err(
				new Error(
					"Archive exceeds bounds or contains a source map/machine path.",
				),
			);
	}
	const names = files.map((file) => relative(join(unpacked, "package"), file));
	if (
		!names.includes("bin/kabane.js") ||
		names.some(
			(name) =>
				!["package.json", "README.md", "LICENSE", "bin/kabane.js"].includes(
					name,
				) &&
				!/^bin\/chunk-[a-z0-9]{8}\.js$/.test(name) &&
				!name.startsWith("templates/"),
		)
	)
		return err(new Error("Unexpected published package file shape."));
	const raw = readArtifactFile(join(unpacked, "package/package.json"), 65_536);
	if (!raw.ok) return raw;
	if (raw.value.toString().includes("@cabane/"))
		return err(
			new Error("Published manifest names a private workspace package."),
		);
	const parsed = PublishManifestSchema.safeParse(
		JSON.parse(raw.value.toString()),
	);
	return parsed.success
		? ok(parsed.data)
		: err(
				new Error(
					"Invalid published manifest (identity/bin/engine/exact externals).",
				),
			);
};

/** Validate members and types before tar gets permission to extract anything. */
export const inspectArchive = async (
	tarball: string,
	unpacked: string,
	forbiddenPaths: string[] = [],
): Promise<Result<z.infer<typeof PublishManifestSchema>>> => {
	const bytes = readArtifactFile(tarball);
	if (!bytes.ok) return bytes;
	try {
		const headers = verifyTarHeaders(bytes.value);
		if (!headers.ok) return headers;
		const cwd = resolve(unpacked, "..");
		const names = await runUpdateProcess(
			["tar", "-tzf", tarball],
			cwd,
			process.env,
		);
		const types = await runUpdateProcess(
			["tar", "-tvzf", tarball],
			cwd,
			process.env,
		);
		if (
			!names.ok ||
			!types.ok ||
			names.value.code !== 0 ||
			types.value.code !== 0
		)
			return err(new Error("Could not inspect archive."));
		const entries = names.value.stdout.trimEnd().split("\n");
		if (
			!entries.length ||
			entries.some(
				(name) =>
					!name.startsWith("package/") ||
					[...name].some(
						(char) =>
							char.charCodeAt(0) < 32 ||
							char.charCodeAt(0) === 127 ||
							char === "\\",
					) ||
					name.split("/").some((part) => part === ".." || part === "."),
			) ||
			types.value.stdout
				.trimEnd()
				.split("\n")
				.some((line) => !/^[d-]/.test(line))
		)
			return err(
				new Error(
					"Unsafe or unsupported archive members; no extraction attempted.",
				),
			);
		if (existsSync(unpacked))
			return err(new Error("Archive extraction destination must be new."));
		mkdirSync(unpacked);
		const extracted = await runUpdateProcess(
			["tar", "-xzf", tarball, "-C", unpacked],
			cwd,
			process.env,
		);
		if (!extracted.ok || extracted.value.code !== 0)
			return err(new Error("Archive extraction failed."));
		return inspectExtractedPackage(unpacked, forbiddenPaths);
	} catch {
		return err(new Error("Invalid archive or published manifest."));
	}
};

export const verifyReleaseFiles = (
	directory: string,
): Result<ReleaseManifest> => {
	try {
		const raw = readArtifactFile(join(directory, "manifest.json"), 65_536);
		if (!raw.ok) return raw;
		const parsed = ReleaseManifestSchema.safeParse(
			JSON.parse(raw.value.toString()),
		);
		if (!parsed.success) return err(new Error("Invalid release manifest."));
		const record = parsed.data;
		if (
			record.filename !== `kabane-${record.version}.tgz` ||
			(record.tag !== null && record.tag !== `v${record.version}`)
		)
			return err(new Error("Release filename/version/tag mismatch."));
		const archive = readArtifactFile(join(directory, record.filename));
		const notes = readArtifactFile(join(directory, "release-notes.md"), 32_768);
		const checksum = readArtifactFile(join(directory, "SHA256SUMS"), 1024);
		if (!archive.ok || !notes.ok || !checksum.ok)
			return err(new Error("Missing release archive/checksum/notes."));
		if (
			sha256(archive.value) !== record.sha256 ||
			integrity(archive.value) !== record.integrity ||
			sha256(notes.value) !== record.notesSha256 ||
			checksum.value.toString() !== releaseChecksums(record)
		)
			return err(new Error("Release archive/checksum/notes hash mismatch."));
		for (const binary of record.binaries ?? []) {
			const bytes = readArtifactFile(
				join(directory, binary.filename),
				268_435_456,
			);
			if (!bytes.ok || sha256(bytes.value) !== binary.sha256)
				return err(new Error(`Binary checksum mismatch: ${binary.filename}`));
		}
		return ok(record);
	} catch {
		return err(new Error("Could not verify release files."));
	}
};
