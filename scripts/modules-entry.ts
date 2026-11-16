/**
 * What a modules entry reaches. Every process that opens the database imports each enabled
 * extension's modules entry, `kabane list` included, so the entry imports only what its module
 * objects need (`ARCHITECTURE.md`, "Every process that opens the database registers the same
 * modules"). This walks its relative imports, syntax only as `layers.ts` parses them, and names
 * every file that reaches the extension's main entry, a board, a command or a harness client.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
	basename,
	dirname,
	extname,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { z } from "zod";
import { importSpecifiers } from "./layers";

const Manifest = z.object({
	kabane: z.object({ extension: z.string(), modules: z.string().optional() }),
});

/** Bare imports that are a board or a harness client. */
const FORBIDDEN = [
	"@cabane/board",
	"@cabane/acp",
	"@opentui/",
	"react",
	"@agentclientprotocol/",
];

const forbidden = (specifier: string): boolean =>
	FORBIDDEN.some((prefix) =>
		prefix.endsWith("/")
			? specifier.startsWith(prefix)
			: specifier === prefix || specifier.startsWith(`${prefix}/`),
	);

/** A command or board file by its name: `commands.ts`, `commands/…`, `board*.ts`, any `.tsx`. */
const uiOrCommand = (path: string): boolean =>
	extname(path) === ".tsx" ||
	path
		.split(sep)
		.map((part) => basename(part, extname(part)))
		.some((part) => /^commands?$/.test(part) || part.startsWith("board"));

const resolveRelative = (from: string, specifier: string): string | undefined =>
	["", ".ts", ".tsx", "/index.ts", "/index.tsx"]
		.map((suffix) => resolve(dirname(from), `${specifier}${suffix}`))
		.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());

/** One line per file or import a modules entry must not reach; empty without a modules entry. */
export const modulesEntryFindings = (dir: string): string[] => {
	const manifest = Manifest.parse(
		JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
	).kabane;
	if (manifest.modules === undefined) return [];
	const root = realpathSync(dir);
	const main = resolveRelative(join(root, "package.json"), manifest.extension);
	const entry = resolveRelative(join(root, "package.json"), manifest.modules);
	if (entry === undefined)
		return [`${manifest.modules}: the modules entry does not resolve`];
	const findings: string[] = [];
	const seen = new Set<string>();
	const queue = [entry];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		if (seen.has(file)) continue;
		seen.add(file);
		const at = relative(root, file);
		if (file === main) findings.push(`${at}: the extension's main entry`);
		else if (uiOrCommand(at)) findings.push(`${at}: a board or command file`);
		for (const { specifier, line } of importSpecifiers(file)) {
			if (specifier.startsWith(".")) {
				const next = resolveRelative(file, specifier);
				if (next !== undefined) queue.push(next);
			} else if (forbidden(specifier))
				findings.push(
					`${at}:${line}: imports ${specifier}, a board or harness client`,
				);
		}
	}
	return findings;
};
