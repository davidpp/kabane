// An extension kabane ships under a new name (`Extensions.RENAMED`). A device that enabled it under
// the old one still names it in `extensions`, keeps its settings under the old namespace and its
// link in $KABANE_HOME/extensions, so nothing loads it. `--fix` checks every destination before it
// writes anything, links this kabane's copy of the new name, moves the settings files, and switches
// the config last, so a refusal leaves a working device. The extension's own data module renames its
// tables when it next registers.
import {
	existsSync,
	lstatSync,
	readdirSync,
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

/** `config.json` as it reads with `rename` applied, unsaved; undefined when nothing in it names `from`. */
const renamedConfig = (
	home: string,
	rename: Rename,
): Result<Record<string, unknown> | undefined> => {
	if (!existsSync(configPath(home))) return ok(undefined);
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
	return ok(stored);
};

/**
 * This kabane's own copy of `name`: beside a release binary, or in the checkout it runs from
 * (this file is `<checkout>/packages/cli/src/doctor/renamed.ts`).
 */
const ownCopy = (name: string): string | undefined => {
	const root =
		Extensions.shippedRoot() ??
		resolve(import.meta.dir, "../../../../extensions");
	const path = join(root, name);
	return existsSync(join(path, "package.json")) ? path : undefined;
};

/** Every write the fix makes, decided before the first one. */
type Plan = {
	/** The copy `$KABANE_HOME/extensions/<to>` is linked to; undefined when `<to>` is installed. */
	link?: string;
	/** Settings files, each with the path it moves to. */
	files: (readonly [string, string])[];
	/** The old link, removed; a directory there is the user's own copy and stays. */
	oldLink?: string;
	keptDirectory?: string;
	/** `config.json` to save, last. */
	config?: Record<string, unknown>;
};

/** What `--fix` would do, or the first reason it refuses, before anything is written. */
const plan = async (
	ctx: Extension.Ctx,
	rename: Rename,
): Promise<Result<Plan>> => {
	const { from, to } = rename;
	const config = renamedConfig(ctx.home, rename);
	if (!config.ok) return config;
	const files = await settingsFiles(ctx, rename);
	if (!files.ok) return files;
	const moves = files.value.map(
		(path) => [path, join(dirname(path), `${to}.json`)] as const,
	);
	const taken = moves.find(([, destination]) => existsSync(destination));
	if (taken)
		return err(
			new Error(
				`Refused: ${taken[1]} already exists beside ${taken[0]}; merge them by hand. Nothing was changed`,
			),
		);
	const target = Extensions.directory(ctx.home, to);
	let link: string | undefined;
	if (!Extensions.installed(ctx.home, to)) {
		if (lstatSync(target, { throwIfNoEntry: false }) !== undefined)
			return err(
				new Error(
					`Refused: ${target} is there but holds no extension; remove it, then run kabane doctor --fix again. Nothing was changed`,
				),
			);
		link = ownCopy(to);
		if (link === undefined)
			return err(
				new Error(
					`Refused: this kabane has no copy of the ${to} extension to link at ${target}; install ${to} there and run kabane doctor --fix again. Nothing was changed`,
				),
			);
	}
	const old = Extensions.directory(ctx.home, from);
	const there = lstatSync(old, { throwIfNoEntry: false });
	return ok({
		...(link === undefined ? {} : { link }),
		files: moves,
		...(there?.isSymbolicLink() ? { oldLink: old } : {}),
		...(there?.isDirectory() ? { keptDirectory: old } : {}),
		...(config.value === undefined ? {} : { config: config.value }),
	});
};

/** The plan's writes: the new extension installed first, the config that enables it last. */
const apply = (
	home: string,
	{ from, to }: Rename,
	plan: Plan,
): Result<string> => {
	const done = trySync(() => {
		if (plan.link !== undefined)
			symlinkSync(plan.link, Extensions.directory(home, to));
		for (const [path, destination] of plan.files) renameSync(path, destination);
		if (plan.oldLink !== undefined) rmSync(plan.oldLink);
	});
	if (!done.ok) return done;
	if (plan.config !== undefined) {
		const saved = saveConfig(home, plan.config);
		if (!saved.ok) return saved;
	}
	const linked =
		plan.link === undefined
			? ""
			: `; linked ${Extensions.directory(home, to)} to ${plan.link}`;
	const kept =
		plan.keptDirectory === undefined
			? ""
			: `; left ${plan.keptDirectory}, a copied directory, in place: remove it once nothing needs it`;
	return ok(`${from} is now ${to}${linked}${kept}`);
};

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
			// Planned again: another repair of this run may have changed them since.
			fix: async () => {
				const planned = await plan(ctx, rename);
				return planned.ok ? apply(ctx.home, rename, planned.value) : planned;
			},
		});
	}
	return ok(findings);
};
