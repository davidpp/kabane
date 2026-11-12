/**
 * Storage — the scope scheme's rename.
 *
 * A scope was `jake://scope/<id>` until schema 10, after the planner core was
 * extracted from, and is `kabane://scope/<id>` since (JCAB-223). Storage
 * normalizes every scope it is handed (`normalizeScopeUri`), so the old scheme
 * reaches a database two other ways only: the rows already in it, which
 * migration 10 rewrites, and a row pulled from a device on an older schema,
 * which sync apply rewrites before it resolves the op.
 */

import type { Db } from "../db/port";
import { ScopeUri } from "../scope/uri";
import { TABLES } from "./helpers";

type Row = Record<string, unknown>;

export namespace ScopeScheme {
	/** A `scope_refs` value, a JSON array of `{ scopeUri, role }`, with every scope renamed. */
	const renamedRefs = (raw: string): string => {
		try {
			const refs: unknown = JSON.parse(raw);
			if (!Array.isArray(refs)) return raw;
			return JSON.stringify(
				refs.map((ref: unknown) =>
					typeof ref === "object" &&
					ref !== null &&
					"scopeUri" in ref &&
					typeof ref.scopeUri === "string"
						? { ...ref, scopeUri: ScopeUri.current(ref.scopeUri) }
						: ref,
				),
			);
		} catch {
			// Not JSON: nothing reads it as refs, so nothing is renamed in it.
			return raw;
		}
	};

	const holdsLegacy = (value: unknown): value is string =>
		typeof value === "string" && value.includes(ScopeUri.LEGACY_PREFIX);

	/**
	 * `row`, a snapshot of a stored row, with its scopes under the scheme in
	 * force. The same object when it holds none under the old one.
	 */
	export const inRow = <T extends Row>(row: T): T => {
		const scopeUri = holdsLegacy(row.scope_uri)
			? ScopeUri.current(row.scope_uri)
			: row.scope_uri;
		const scopeRefs = holdsLegacy(row.scope_refs)
			? renamedRefs(row.scope_refs)
			: row.scope_refs;
		return scopeUri === row.scope_uri && scopeRefs === row.scope_refs
			? row
			: { ...row, scope_uri: scopeUri, scope_refs: scopeRefs };
	};

	/**
	 * Migration 10: every stored scope, and every op still in this device's log,
	 * moves to the scheme in force. No row's version or clock moves and nothing
	 * is captured: each device renames its own rows, and the same row renamed on
	 * two devices is the same row.
	 */
	export const migrate = (db: Db): void => {
		const legacy = ScopeUri.LEGACY_PREFIX;
		for (const table of [TABLES.tasks, TABLES.projects, TABLES.sequences]) {
			db.run(
				`UPDATE ${table} SET scope_uri = ? || substr(scope_uri, ?)
				  WHERE substr(scope_uri, 1, ?) = ?`,
				[ScopeUri.PREFIX, legacy.length + 1, legacy.length, legacy],
			);
		}

		const withRefs = db
			.query<{ id: string; scope_refs: string }, [string]>(
				`SELECT id, scope_refs FROM ${TABLES.tasks} WHERE instr(scope_refs, ?) > 0`,
			)
			.all(legacy);
		for (const task of withRefs) {
			db.run(`UPDATE ${TABLES.tasks} SET scope_refs = ? WHERE id = ?`, [
				renamedRefs(task.scope_refs),
				task.id,
			]);
		}

		// The filter also catches a row that only mentions the old scheme in
		// its text; `inRow` returns that one as it is.
		const ops = db
			.query<{ seq: number; payload: string }, [string]>(
				`SELECT seq, payload FROM ${TABLES.sync_oplog} WHERE instr(payload, ?) > 0`,
			)
			.all(legacy);
		for (const op of ops) {
			const row: unknown = JSON.parse(op.payload);
			if (typeof row !== "object" || row === null || Array.isArray(row))
				continue;
			const renamed = inRow(row as Row);
			if (renamed === row) continue;
			db.run(`UPDATE ${TABLES.sync_oplog} SET payload = ? WHERE seq = ?`, [
				JSON.stringify(renamed),
				op.seq,
			]);
		}
	};
}
