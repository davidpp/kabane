import { cpSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ChannelVersionSchema } from "../packages/cli/src/update-version";
import { err, ok, type Result } from "../packages/core/result";
import {
	BinaryTargetSchema,
	BinaryArtifactSchema,
	ReleaseVersionSchema,
	readArtifactFile,
	releaseChecksums,
	sha256,
	verifyReleaseFiles,
} from "./release-artifact";

const ProducerSchema = z
	.object({
		target: BinaryTargetSchema,
		filename: z.string(),
		sha256: z.string(),
		version: ChannelVersionSchema,
		commit: z.string(),
		bun: ReleaseVersionSchema,
	})
	.strict();

/** Assemble retained native outputs; never rebuild or repack during transfer/publication. */
export const attachBinaries = (
	directory: string,
	producers: string,
): Result<void> => {
	try {
		const verified = verifyReleaseFiles(directory);
		if (!verified.ok) return verified;
		if (verified.value.binaries)
			return err(
				new Error(
					"Release already has binaries; verify its retained bytes instead.",
				),
			);
		const binaries: z.infer<typeof BinaryArtifactSchema>[] = [];
		for (const target of BinaryTargetSchema.options) {
			const raw = readArtifactFile(
				join(producers, `native-${target}`, `${target}.json`),
				65_536,
			);
			if (!raw.ok) return raw;
			const parsed = ProducerSchema.safeParse(JSON.parse(raw.value.toString()));
			if (!parsed.success)
				return err(new Error(`Invalid binary producer: ${target}`));
			const source = parsed.data;
			const binary = BinaryArtifactSchema.safeParse({
				target: source.target,
				filename: source.filename,
				sha256: source.sha256,
			});
			if (
				!binary.success ||
				source.target !== target ||
				source.commit !== verified.value.commit ||
				source.version !== verified.value.version ||
				source.bun !== verified.value.bun
			)
				return err(new Error(`Binary source/version/tool mismatch: ${target}`));
			const bytes = readArtifactFile(
				join(producers, `native-${target}`, source.filename),
				268_435_456,
			);
			if (!bytes.ok || sha256(bytes.value) !== source.sha256)
				return err(new Error(`Binary checksum mismatch: ${target}`));
			binaries.push(binary.data);
		}
		for (const binary of binaries)
			cpSync(
				join(producers, `native-${binary.target}`, binary.filename),
				join(directory, binary.filename),
				{ errorOnExist: true, force: false },
			);
		const record = { ...verified.value, binaries };
		writeFileSync(
			join(directory, "manifest.json"),
			`${JSON.stringify(record, null, 2)}\n`,
		);
		writeFileSync(join(directory, "SHA256SUMS"), releaseChecksums(record));
		const checked = verifyReleaseFiles(directory);
		return checked.ok ? ok(undefined) : checked;
	} catch (cause) {
		return err(new Error(`Binary assembly failed: ${String(cause)}`));
	}
};

if (import.meta.main) {
	const [directory, producers, ...extra] = process.argv.slice(2);
	const result =
		directory && producers && !extra.length
			? attachBinaries(resolve(directory), resolve(producers))
			: err(
					new Error(
						"Usage: bun scripts/release-binaries.ts <release-directory> <native-artifacts-directory>",
					),
				);
	if (!result.ok) {
		console.error(result.error.message);
		process.exitCode = 1;
	}
}
