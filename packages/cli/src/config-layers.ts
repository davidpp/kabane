/**
 * Where each settings layer is stored on a device, for `Settings` to merge:
 *
 * - user: the namespace's key in `KABANE_HOME/config.json` (`"loop": {...}`);
 * - project: `<projectDir>/.kabane/<namespace>.json`, checked in with the repo;
 * - user for one scope: `scopes.<scopeId>.<namespace>` in the same `config.json`, keyed by the
 *   scope id the repo detects, so it holds in every checkout and worktree of the project and never
 *   puts a file in a repo the user does not own.
 *
 * The per-scope layer lives in `config.json` rather than in files under `KABANE_HOME/scopes/`:
 * a scope id is a path (`github.com/owner/repo`), so a file per scope would need an encoding; and
 * one document keeps `kabane config set` one read-edit-validate-write, whatever the layer.
 *
 * Only namespaces have a project or scope layer, and no namespace may take a device key's name
 * (`Extensions.namespaces`), so a checked-in file can never redirect the database or the hub.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result, toError, trySync } from "@cabane/core";
import { MARKER_DIR } from "@cabane/core/scope";
import type { Settings } from "@cabane/extension";
import { configPath, isPlainObject } from "./config";

export namespace ConfigLayers {
	/** The key of `config.json` that holds the user's settings by scope id. */
	export const SCOPES = "scopes";

	/** Where settings resolve for: a project checkout, and the scope whose user settings apply. */
	export type Where = { projectDir?: string; scopeId?: string };

	export const projectFile = (projectDir: string, namespace: string): string =>
		join(projectDir, MARKER_DIR, `${namespace}.json`);

	export const scopeLabel = (home: string, scopeId: string): string =>
		`your settings for scope ${scopeId} in ${configPath(home)}`;

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

	export const writeJson = (path: string, value: unknown): Result<string> => {
		const written = trySync(() => {
			const indent = indentOf(path);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(value, null, indent)}\n`);
			return path;
		});
		return written.ok ? written : err(toError(written.error));
	};

	/** `config.json`'s per-scope block for `scopeId`, refused when it is not an object of objects. */
	export const scopeBlock = (
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

	/**
	 * `namespace`'s layers at `where`, lowest first, from the stored `config.json` (absent before
	 * `kabane init`) and the project's file. A layer that holds nothing is left out.
	 */
	export const sources = (
		home: string,
		stored: Record<string, unknown> | undefined,
		namespace: string,
		where: Where,
	): Result<Settings.Source[]> => {
		const found: Settings.Source[] = [];
		const user = stored?.[namespace];
		if (user !== undefined)
			found.push({ layer: "user", label: configPath(home), value: user });
		if (where.projectDir !== undefined) {
			const path = projectFile(where.projectDir, namespace);
			const file = readJson(path);
			if (!file.ok) return file;
			if (file.value !== undefined)
				found.push({ layer: "project", label: path, value: file.value });
		}
		if (stored !== undefined && where.scopeId !== undefined) {
			const block = scopeBlock(home, stored, where.scopeId);
			if (!block.ok) return block;
			const value = block.value?.[namespace];
			if (value !== undefined)
				found.push({
					layer: "scope",
					label: scopeLabel(home, where.scopeId),
					value,
				});
		}
		return ok(found);
	};
}
