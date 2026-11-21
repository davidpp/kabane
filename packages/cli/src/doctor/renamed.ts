// An extension kabane ships under a new name (`Extensions.RENAMED`). A device that enabled it under
// the old one still names it in `extensions`, keeps its settings under the old namespace and its
// link in $KABANE_HOME/extensions, so nothing loads it. `--fix` moves all three; the extension's
// own data module renames its tables when it next registers.
import {
	existsSync,
	lstatSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { err, ok, type Result, trySync } from "@kabane/core";
import type { Doctor, Extension } from "@kabane/extension";
import {
	configPath,
	isPlainObject,
	loadConfigDocument,
	saveConfig,
} from "../config";
import { ConfigLayers } from "../config-layers";
import { projectAt } from "../context";
import { Extensions } from "../extensions";

type Rename = { from: string; to: string };

/** Each settings file named after the old namespace: every project's local layer, and this project's shared one. */
const settingsFiles = async (
	ctx: Extension.Ctx,
	{ from }: Rename,
): Promise<Result<string[]>> => {
	const projects = join(ctx.home, "projects");
	const local = existsSync(projects)
		? readdirSync(projects).map((dir) => join(projects, dir, `${from}.json`))
		: [];
	const project = await projectAt(ctx.cwd, ctx.home);
	if (!project.ok) return project;
	const shared = project.value
		? [ConfigLayers.sharedFile(project.value.root, from)]
		: [];
	return ok([...local, ...shared].filter((path) => existsSync(path)));
};

const isLink = (path: string): boolean =>
	lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;

/** What in `stored` still names `from`: the `extensions` entry, the global namespace, a legacy scope's. */
const inConfig = (stored: Record<string, unknown>, { from }: Rename): boolean =>
	(Array.isArray(stored.extensions) && stored.extensions.includes(from)) ||
	Object.hasOwn(stored, from) ||
	(isPlainObject(stored.scopes) &&
		Object.values(stored.scopes).some(
			(block) => isPlainObject(block) && Object.hasOwn(block, from),
		));

/** `object[from]` moved to `object[to]`; refused when `to` already holds something. */
const moveKey = (
	object: Record<string, unknown>,
	{ from, to }: Rename,
	where: string,
): Result<void> => {
	if (!Object.hasOwn(object, from)) return ok(undefined);
	if (Object.hasOwn(object, to))
		return err(
			new Error(
				`Refused: ${where} holds both ${from} and ${to}; merge ${from} into ${to} by hand and remove it`,
			),
		);
	object[to] = object[from];
	delete object[from];
	return ok(undefined);
};

const renameConfig = (home: string, rename: Rename): Result<void> => {
	const document = loadConfigDocument(home);
	if (!document.ok) return document;
	const stored = document.value.stored;
	if (!inConfig(stored, rename)) return ok(undefined);
	if (Array.isArray(stored.extensions))
		stored.extensions = [
			...new Set(
				stored.extensions.map((name) =>
					name === rename.from ? rename.to : name,
				),
			),
		];
	const path = configPath(home);
	const global = moveKey(stored, rename, path);
	if (!global.ok) return global;
	if (isPlainObject(stored.scopes))
		for (const [scope, block] of Object.entries(stored.scopes))
			if (isPlainObject(block)) {
				const moved = moveKey(block, rename, `scopes.${scope} in ${path}`);
				if (!moved.ok) return moved;
			}
	const saved = saveConfig(home, stored);
	return saved.ok ? ok(undefined) : saved;
};

const renameFile = (path: string, { to }: Rename): Result<void> => {
	const destination = join(dirname(path), `${to}.json`);
	if (existsSync(destination))
		return err(
			new Error(
				`Refused: ${destination} already exists beside ${path}; merge them by hand`,
			),
		);
	return trySync(() => renameSync(path, destination));
};

/**
 * The old link re-pointed under the new name, at the new name beside what it linked to (a source
 * checkout's `extensions/`, or an install's), else at this install's copy, then removed. A
 * directory there is the user's own install and stays.
 */
const relink = (home: string, { from, to }: Rename): Result<void> =>
	trySync(() => {
		const old = Extensions.directory(home, from);
		if (!isLink(old)) return;
		const sibling = join(dirname(resolve(dirname(old), readlinkSync(old))), to);
		const target = Extensions.directory(home, to);
		if (lstatSync(target, { throwIfNoEntry: false }) === undefined) {
			if (existsSync(sibling)) symlinkSync(sibling, target);
			else {
				const linked = Extensions.link(home, [to]);
				if (!linked.ok) throw linked.error;
			}
		}
		rmSync(old);
	});

export const renamed = async (
	ctx: Extension.Ctx,
): Promise<Result<Doctor.Finding[]>> => {
	const findings: Doctor.Finding[] = [];
	const document = existsSync(configPath(ctx.home))
		? loadConfigDocument(ctx.home)
		: undefined;
	for (const [from, to] of Object.entries(Extensions.RENAMED)) {
		const rename = { from, to };
		const files = await settingsFiles(ctx, rename);
		if (!files.ok) return files;
		const named = [
			// An unreadable config is the settings check's finding.
			...(document?.ok && inConfig(document.value.stored, rename)
				? [configPath(ctx.home)]
				: []),
			...files.value,
			...(isLink(Extensions.directory(ctx.home, from))
				? [Extensions.directory(ctx.home, from)]
				: []),
		];
		if (named.length === 0) continue;
		findings.push({
			id: `extension-renamed-${from}`,
			severity: "auto",
			summary: `The ${from} extension is now ${to}, and ${named.join(", ")} still name it ${from}, so it does not load. --fix renames its extensions entry, its ${from}.* settings and its link to ${to}; ${to} renames its tables the next time it opens the database.`,
			// Read again: another repair of this run may have changed them since.
			fix: async () => {
				const config = existsSync(configPath(ctx.home))
					? renameConfig(ctx.home, rename)
					: ok(undefined);
				if (!config.ok) return config;
				const now = await settingsFiles(ctx, rename);
				if (!now.ok) return now;
				for (const path of now.value) {
					const moved = renameFile(path, rename);
					if (!moved.ok) return moved;
				}
				const linked = relink(ctx.home, rename);
				return linked.ok ? ok(`${from} is now ${to}`) : linked;
			},
		});
	}
	return ok(findings);
};
