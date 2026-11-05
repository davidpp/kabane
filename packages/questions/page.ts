import {
	err,
	fingerprintText as digest,
	normalizeScopeUri,
	ok,
	PageOptionsSchema,
	Planner,
	type Result,
	serializedBytes,
} from "@cabane/core";
import { z } from "zod";
import { questionsMarkdown } from "./markdown";
import type { QuestionView } from "./schema";
import { Questions } from "./storage";

export const ListSchema = PageOptionsSchema.extend({
	id: z.string().min(1).optional(),
	scopeUri: z.string().optional(),
	status: z.enum(["open", "all"]).default("open"),
});
const CursorSchema = z
	.object({
		v: z.literal(1),
		binding: z.string(),
		fingerprint: z.string(),
		offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	})
	.strict();
type Cursor = z.infer<typeof CursorSchema>;
const decode = (text?: string): Result<Cursor | undefined> => {
	if (text === undefined) return ok(undefined);
	try {
		const parsed = CursorSchema.safeParse(JSON.parse(text));
		if (parsed.success) return ok(parsed.data);
	} catch {
		/* Invalid JSON gets the same actionable error as invalid fields. */
	}
	return err(new Error("Invalid questions cursor; restart without cursor."));
};

/** One page of question rows: the rows shown, and the cursor to the rest when there is more. */
export type QuestionRowPage = { rows: QuestionView[]; nextCursor?: string };

/** The page's markdown, the final cursor line passed back unchanged. */
export const questionPageMarkdown = (page: QuestionRowPage): string =>
	page.rows.length
		? questionsMarkdown(page.rows) +
			(page.nextCursor ? `\n\nnextCursor: ${page.nextCursor}` : "")
		: "No questions found.";

/** The one paging path: cursor validation, filter binding and the 16KiB bound of its markdown. */
export const questionRowPage = async (
	basePath: string,
	input: z.input<typeof ListSchema>,
): Promise<Result<QuestionRowPage>> => {
	const parsed = ListSchema.safeParse(input);
	if (!parsed.success)
		return err(new Error(`Invalid questions query: ${parsed.error.message}`));
	const options = parsed.data;
	const cursor = decode(options.cursor);
	if (!cursor.ok) return cursor;
	let id: string | undefined;
	if (options.id !== undefined) {
		const task = await Planner.resolveTaskId(basePath, options.id);
		if (!task.ok) return task;
		id = task.value;
	}
	const scope =
		options.scopeUri === undefined
			? ok(undefined)
			: normalizeScopeUri(options.scopeUri);
	if (!scope.ok) return scope;
	const filter = { id, scopeUri: scope.value, status: options.status };
	const binding = await digest(JSON.stringify(filter));
	if (!binding.ok) return binding;
	if (cursor.value && cursor.value.binding !== binding.value)
		return err(
			new Error(
				"Mismatched questions cursor: repeat the same issue, scope and status, or restart without cursor.",
			),
		);
	const rows = await Questions.list(basePath, filter);
	if (!rows.ok) return rows;
	const fingerprint = await digest(JSON.stringify(rows.value));
	if (!fingerprint.ok) return fingerprint;
	const offset = cursor.value?.offset ?? 0;
	if (
		cursor.value &&
		(cursor.value.fingerprint !== fingerprint.value ||
			offset >= rows.value.length)
	)
		return err(
			new Error(
				"Stale questions cursor: matching questions or issues changed; restart without cursor.",
			),
		);
	return packPage(
		rows.value,
		options.limit,
		offset,
		binding.value,
		fingerprint.value,
	);
};

/** Markdown is the payload; the final cursor line is passed back unchanged. */
export const questionPage = async (
	basePath: string,
	input: z.input<typeof ListSchema>,
): Promise<Result<string>> => {
	const page = await questionRowPage(basePath, input);
	return page.ok ? ok(questionPageMarkdown(page.value)) : page;
};

const packPage = (
	rows: QuestionView[],
	limit: number,
	offset: number,
	binding: string,
	fingerprint: string,
): Result<QuestionRowPage> => {
	if (!rows.length) return ok({ rows: [] });
	const slice = (count: number): QuestionRowPage => {
		const after = offset + count;
		return {
			rows: rows.slice(offset, after),
			...(after < rows.length
				? {
						nextCursor: JSON.stringify({
							v: 1,
							binding,
							fingerprint,
							offset: after,
						}),
					}
				: {}),
		};
	};
	let count = Math.min(limit, rows.length - offset);
	while (count > 0) {
		const page = slice(count);
		if (serializedBytes(questionPageMarkdown(page)) <= 16 * 1024)
			return ok(page);
		count--;
	}
	return err(
		new Error(
			`Question ${rows[offset]?.handle} exceeds the 16KiB page budget; read its issue with kabane_context, sections: ["questions.decisions"].`,
		),
	);
};
