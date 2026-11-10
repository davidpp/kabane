/**
 * Where each settings layer is stored on a device, for `Settings` to merge:
 *
 * - global: the namespace's key in `KABANE_HOME/config.json` (`"loop": {...}`), for every project;
 * - shared: `<projectDir>/.kabane/<namespace>.json`, checked in, for everyone who clones the repo;
 * - local: `KABANE_HOME/projects/<slug>/<namespace>.json`, for this project, for you, on this
 *   device. Keyed by the project's path (`ProjectDirs`), from the main checkout for a worktree, so
 *   it never puts a file in the repo and survives the project's scope id changing.
 *
 * Before local was keyed by path it was `scopes.<scopeId>.<namespace>` in `config.json`. Those
 * blocks are still read, as local just under the file, and never written: a scope id changes
 * during a project's life, and nothing syncs `config.json` to give the id a reach a path lacks.
 *
 * A local file is written whole through a rename, since the board, MCP and the CLI can write at
 * once. Only namespaces have a shared or local layer, and no namespace may take a device key's
 * name (`Extensions.namespaces`), so a checked-in file can never redirect the database or the hub.
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result, toError, trySync } from "@cabane/core";
import { MARKER_DIR, ProjectDirs } from "@cabane/core/scope";
import type { Settings } from "@cabane/extension";
import { configPath, isPlainObject } from "./config";

export namespace ConfigLayers {
	/** The key of `config.json` that holds the legacy local settings, by scope id. */
	export const SCOPES = "scopes";

	/**
	 * Where settings resolve for: the checkout whose `.kabane/` is the shared layer, the project
	 * root that keys the local layer, and the scope whose legacy `scopes` block is read.
	 */
	export type Where = {
		projectDir?: string;
		localRoot?: string;
		scopeId?: string;
	};

	export const sharedFile = (projectDir: string, namespace: string): string =>
		join(projectDir, MARKER_DIR, `${namespace}.json`);

	export const localFile = (
		home: string,
		localRoot: string,
		namespace: string,
	): string => join(ProjectDirs.of(home, localRoot), `${namespace}.json`);

	export const scopeLabel = (home: string, scopeId: string): string =>
		`${SCOPES}.${scopeId} in ${configPath(home)}`;

	/** A JSON file's contents, or undefined when there is none. */
	export const readJson = (path: string): Result<unknown> => {
		if (!existsSync(path)) return ok(undefined);
		const text = trySync(() => readFileSync(path, "utf8"));
		if (!text.ok) return err(toError(text.error));
		const json = trySync((): unknown => JSON.parse(text.value));
		return json.ok
			? json
			: err(new Error(`${path}: ${toError(json.error).message}`));
	};

	// A file someone formats (the repo's own formatter) keeps its indent; a new one gets two spaces.
	const indentOf = (path: string): string => {
		const text = existsSync(path) ? readFileSync(path, "utf8") : "";
		return /\n([\t ]+)"/.exec(text)?.[1] ?? "  ";
	};

	/** Written whole through a rename, so a reader never sees half of it. */
	export const writeJson = (path: string, value: unknown): Result<string> => {
		const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
		const written = trySync(() => {
			const indent = indentOf(path);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(temp, `${JSON.stringify(value, null, indent)}\n`);
			renameSync(temp, path);
			return path;
		});
		if (written.ok) return written;
		// The write's error is the one worth reporting; a failed cleanup only leaves a stray temp file.
		trySync(() => rmSync(temp, { force: true }));
		return err(toError(written.error));
	};

	/** `config.json`'s per-scope block for `scopeId`, refused when it is not an object of objects. */
	const scopeBlock = (
		home: string,
		stored: Record<string, unknown>,
		scopeId: string,
	): Result<Record<string, unknown> | undefined> => {
		const scopes = stored[SCOPES];
		if (scopes === undefined) return ok(undefined);
		const block = isPlainObject(scopes) ? scopes[scopeId] : undefined;
		if (
			!isPlainObject(scopes) ||
			(block !== undefined && !isPlainObject(block))
		)
			return err(
				new Error(
					`Invalid ${SCOPES} in ${configPath(home)}: expected { "<scope id>": { "<namespace>": {...} } }`,
				),
			);
		return ok(block);
	};

	const fileSource = (
		layer: Settings.Source["layer"],
		path: string,
	): Result<Settings.Source[]> => {
		const file = readJson(path);
		if (!file.ok) return file;
		return ok(
			file.value === undefined
				? []
				: [{ layer, label: path, value: file.value }],
		);
	};

	/**
	 * `namespace`'s layers at `where`, lowest first, from the stored `config.json` (absent before
	 * `kabane init`) and the files. A layer that holds nothing is left out.
	 */
	export const sources = (
		home: string,
		stored: Record<string, unknown> | undefined,
		namespace: string,
		where: Where,
	): Result<Settings.Source[]> => {
		const found: Settings.Source[] = [];
		const global = stored?.[namespace];
		if (global !== undefined)
			found.push({ layer: "global", label: configPath(home), value: global });
		if (where.projectDir !== undefined) {
			const shared = fileSource(
				"shared",
				sharedFile(where.projectDir, namespace),
			);
			if (!shared.ok) return shared;
			found.push(...shared.value);
		}
		if (stored !== undefined && where.scopeId !== undefined) {
			const block = scopeBlock(home, stored, where.scopeId);
			if (!block.ok) return block;
			const value = block.value?.[namespace];
			if (value !== undefined)
				found.push({
					layer: "local",
					label: scopeLabel(home, where.scopeId),
					value,
				});
		}
		if (where.localRoot !== undefined) {
			const local = fileSource(
				"local",
				localFile(home, where.localRoot, namespace),
			);
			if (!local.ok) return local;
			found.push(...local.value);
		}
		return ok(found);
	};
}
