/**
 * What a record row is, read from its URI and kind (JCAB-660). The `refs`
 * table holds links, context refs and upstream links, and `entries` holds the
 * timeline and the work log. Nothing about it is stored: a ref to
 * `kabane://thread/<id>` is a link, a ref of kind `upstream` an upstream link,
 * any other a context ref; an entry of kind `log` is the work log's, any other
 * the timeline's. The writers keep those shapes apart: a context ref takes no
 * thread URI and no link or upstream kind, and a timeline entry no `log` kind,
 * so two families never meet on one key.
 */

import { RecordKey } from "../schemas";
import { LinkTypeSchema } from "../schemas/link";

export type RefFamily = "link" | "context" | "upstream";

/** The entry kind a work log is stored under, and no other entry. */
export const WORK_LOG_KIND = "log";

/** The kind of an upstream link's ref. */
export const UPSTREAM_KIND = "upstream";

/** Kinds a context ref cannot take: each link type's, and an upstream link's. */
export const RESERVED_REF_KINDS: readonly string[] = [
	...LinkTypeSchema.options,
	UPSTREAM_KIND,
];

export const refFamily = (ref: { uri: string; kind: string }): RefFamily =>
	ref.uri.startsWith(RecordKey.THREAD_URI_PREFIX)
		? "link"
		: ref.kind === UPSTREAM_KIND
			? "upstream"
			: "context";

/** The same rule in SQL over a `refs` row aliased `r`. */
export const REF_FAMILY_SQL = `CASE
  WHEN substr(r.uri, 1, ${RecordKey.THREAD_URI_PREFIX.length}) = '${RecordKey.THREAD_URI_PREFIX}' THEN 'link'
  WHEN r.kind = '${UPSTREAM_KIND}' THEN 'upstream'
  ELSE 'context' END`;

export const isWorkLog = (entry: { kind: string }): boolean =>
	entry.kind === WORK_LOG_KIND;
