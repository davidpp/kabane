import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	lstatSync,
	writeFileSync,
	renameSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { z } from "zod";
import { err, ok, trySync, type Result } from "../../packages/core/result";

export const canonical = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null)
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
};
export const hash = (text: string | Uint8Array): string =>
	createHash("sha256").update(text).digest("hex");
export const read = (path: string): Result<string> =>
	trySync(() => readFileSync(path, "utf8"));
export const readJson = <T>(
	path: string,
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Result<T> => {
	const source = read(path);
	if (!source.ok) return source;
	const decoded = trySync((): unknown => JSON.parse(source.value));
	if (!decoded.ok) return decoded;
	const parsed = schema.safeParse(decoded.value);
	return parsed.success
		? ok(parsed.data)
		: err(new Error(`${path}: ${parsed.error.message}`));
};
export const write = (path: string, text: string): Result<void> =>
	trySync(() => {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, text, { mode: 0o600 });
	});
export const writeJson = (path: string, value: unknown): Result<void> =>
	trySync(() => {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(temporary, path);
	});
const excluded = new Set([
	".git",
	"node_modules",
	".DS_Store",
	".env",
	".env.local",
	".dev.vars",
]);
export const tree = (root: string): Result<Record<string, string>> =>
	trySync(() => {
		const files: Record<string, string> = {};
		const walk = (dir: string): void => {
			for (const name of readdirSync(dir).sort()) {
				if (excluded.has(name)) continue;
				const path = join(dir, name);
				const stat = lstatSync(path);
				if (stat.isDirectory()) walk(path);
				else if (stat.isFile())
					files[relative(root, path)] = hash(readFileSync(path));
				else files[relative(root, path)] = "unsupported-non-file";
			}
		};
		walk(root);
		return files;
	});
export const digestTree = (root: string): Result<string> => {
	const files = tree(root);
	return files.ok ? ok(hash(JSON.stringify(files.value))) : files;
};
export const copyTree = (source: string, target: string): Result<void> => {
	const files = tree(source);
	if (!files.ok) return files;
	if (Object.values(files.value).includes("unsupported-non-file"))
		return err(
			new Error(`Symlinks/special files are not allowed in starter ${source}`),
		);
	return trySync(() => {
		mkdirSync(target, { recursive: true, mode: 0o700 });
		for (const name of Object.keys(files.value)) {
			mkdirSync(dirname(join(target, name)), { recursive: true, mode: 0o700 });
			writeFileSync(join(target, name), readFileSync(join(source, name)), {
				mode: lstatSync(join(source, name)).mode & 0o100 ? 0o700 : 0o600,
			});
		}
	});
};
export const isNewDirectory = (path: string): Result<void> =>
	existsSync(path)
		? err(
				new Error(
					`${path} already exists; choose a new directory to preserve prior work.`,
				),
			)
		: ok(undefined);
