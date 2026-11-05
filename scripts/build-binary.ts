#!/usr/bin/env bun
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { err, ok, type Result } from "../packages/core/result";
import { copyTemplates, templateRoots } from "./build";
import { BinaryTargetSchema, sha256 } from "./release-artifact";
import { queryRelease } from "./release-process";

const ROOT = resolve(import.meta.dir, "..");
export const binaryFilename = (
	target: z.infer<typeof BinaryTargetSchema>,
): string => `kabane-${target}.tar.gz`;

/** Native builds ensure Bun resolves the target's installed OpenTUI optional dependency. */
export const buildBinary = async (
	target: string,
	output: string,
): Promise<Result<string>> => {
	const parsed = BinaryTargetSchema.safeParse(target);
	if (!parsed.success || target !== `${process.platform}-${process.arch}`)
		return err(new Error(`Build ${target} on its matching native runner.`));
	let work: string | undefined;
	try {
		mkdirSync(output); // Never replace retained bytes on retry.
		work = mkdtempSync(join(output, "build-"));
		const contents = join(work, "kabane");
		mkdirSync(contents);
		const executable = join(contents, "kabane");
		const compiled = Bun.spawnSync(
			[
				process.execPath,
				"build",
				"--compile",
				"--no-compile-autoload-bunfig",
				"--no-compile-autoload-dotenv",
				`--target=bun-${target}${process.arch === "x64" ? "-baseline" : ""}`,
				"--define",
				'process.env.KABANE_BUNDLED="1"',
				"--define",
				'process.env.NODE_ENV="production"',
				"--outfile",
				executable,
				"packages/cli/index.ts",
			],
			{ cwd: ROOT, stdout: "inherit", stderr: "inherit" },
		);
		if (compiled.exitCode !== 0)
			return err(new Error("Standalone compilation failed."));
		const bytes = readFileSync(executable);
		const library = "libopentui";
		const suffix = process.platform === "darwin" ? "dylib" : "so";
		const embedded = bytes
			.toString("latin1")
			.match(
				new RegExp(
					`[/]\\$bunfs/[^\\x00\\s"']*${library}[^\\x00\\s"']*\\.${suffix}`,
					"g",
				),
			);
		if (!embedded?.length)
			return err(new Error(`No embedded OpenTUI ${suffix} in ${target}.`));
		console.error(
			`binary: ${target}, ${statSync(executable).size} bytes; ${embedded[0]}`,
		);
		const copied = copyTemplates(templateRoots(), join(contents, "templates"));
		if (!copied.ok) return copied;
		for (const name of ["README.md", "LICENSE"])
			cpSync(join(ROOT, name), join(contents, name));
		const filename = binaryFilename(parsed.data);
		const packed = await queryRelease(
			[
				"tar",
				"--format=ustar",
				"-czf",
				join(output, filename),
				"-C",
				work,
				"kabane",
			],
			ROOT,
			{ ...process.env, COPYFILE_DISABLE: "1" },
		);
		if (!packed.ok) return packed;
		const commit = await queryRelease(
			["git", "rev-parse", "HEAD"],
			ROOT,
			process.env,
		);
		if (!commit.ok) return commit;
		const source = z
			.object({ version: z.string() })
			.safeParse(
				JSON.parse(
					readFileSync(join(ROOT, "packages/cli/package.json"), "utf8"),
				),
			);
		if (!source.success) return err(new Error("Invalid CLI version."));
		const hash = sha256(readFileSync(join(output, filename)));
		writeFileSync(
			join(output, `${target}.json`),
			JSON.stringify({
				target,
				filename,
				sha256: hash,
				version: source.data.version,
				commit: commit.value,
				bun: Bun.version,
			}),
		);
		writeFileSync(join(output, "SHA256SUMS"), `${hash}  ${filename}\n`);
		return ok(filename);
	} catch (cause) {
		return err(new Error(`Binary build failed: ${String(cause)}`));
	} finally {
		if (work) rmSync(work, { recursive: true, force: true });
	}
};

if (import.meta.main) {
	const [target, output, ...extra] = process.argv.slice(2);
	const result =
		target && output && !extra.length
			? await buildBinary(target, resolve(output))
			: err(
					new Error(
						"Usage: bun scripts/build-binary.ts <os-arch> <new-output-directory>",
					),
				);
	if (result.ok) console.error(`binary: ${result.value}`);
	else {
		console.error(result.error.message);
		process.exitCode = 1;
	}
}
