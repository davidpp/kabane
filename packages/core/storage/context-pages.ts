import { z } from "zod";
import {
	CONTEXT_BYTES,
	CONTEXT_SECTIONS,
	ContextPageOptionsSchema,
	type ContextPage,
	type ContextPageOptions,
	type ContextSection,
} from "../context-output";
import { err, ok, type Result } from "../result";
import { serializedBytes } from "../task-output";
import { readContextSections } from "./assemble-context";
import { fingerprintText as digest } from "./read-fingerprint";
import { Planner as Tasks } from "./tasks";

const CursorSchema = z
	.object({
		v: z.literal(1),
		binding: z.string().regex(/^[a-f0-9]{64}$/),
		revision: z.string().regex(/^[a-f0-9]{64}$/),
		offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	})
	.strict();
type Cursor = z.infer<typeof CursorSchema>;
const invalidCursor = () =>
	err(
		new Error(
			"Invalid or mismatched context cursor (task, sections or options); restart without cursor.",
		),
	);
const decodeCursor = (text?: string): Result<Cursor | undefined> => {
	if (text === undefined) return ok(undefined);
	try {
		const parsed = CursorSchema.safeParse(JSON.parse(text));
		return parsed.success ? ok(parsed.data) : invalidCursor();
	} catch {
		return invalidCursor();
	}
};
const boundary = (text: string, offset: number): number => {
	const previous = text.charCodeAt(offset - 1);
	const next = text.charCodeAt(offset);
	return previous >= 0xd800 &&
		previous <= 0xdbff &&
		next >= 0xdc00 &&
		next <= 0xdfff
		? offset - 1
		: offset;
};
const RETRIEVAL =
	"Consume all preceding chunks; concatenate markdown by offset. Continue kabane_context with responseFormat: concise, same id/options and nextCursor as cursor; CLI: kabane context <id> --format concise --cursor <nextCursor> (same flags). Retrieve omitted sections with sections / --sections. Finish required description and human steering before starting work.";

const packContextPage = ({
	taskId,
	revision,
	binding,
	offset,
	markdown,
	sections,
	ends,
}: {
	taskId: string;
	revision: string;
	binding: string;
	offset: number;
	markdown: string;
	sections: ContextSection[];
	ends: Map<ContextSection, number>;
}): Result<ContextPage> => {
	const envelope = (end: number): ContextPage => {
		const complete = (section: ContextSection) => {
			const sectionEnd = ends.get(section);
			return sectionEnd !== undefined && sectionEnd <= end;
		};
		return {
			completeness: {
				selectedComplete: end === markdown.length,
				descriptionComplete: complete("description"),
				humanSteeringComplete: complete("discussion"),
				completedSections: sections.filter(complete),
				remainingSections: sections.filter((section) => !complete(section)),
				omittedSections: CONTEXT_SECTIONS.filter(
					(section) => !sections.includes(section),
				),
			},
			taskId,
			revision,
			offset,
			markdown: markdown.slice(offset, end),
			...(end < markdown.length
				? {
						nextCursor: JSON.stringify({
							v: 1,
							binding,
							revision,
							offset: end,
						}),
					}
				: {}),
			retrieval: RETRIEVAL,
		};
	};
	const final = envelope(markdown.length);
	if (serializedBytes(final) <= CONTEXT_BYTES) return ok(final);
	let low = offset + 1;
	let high = markdown.length - 1;
	let page: ContextPage | undefined;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const end = boundary(markdown, middle);
		const candidate = envelope(end);
		if (serializedBytes(candidate) <= CONTEXT_BYTES) {
			if (end > offset) page = candidate;
			low = middle + 1;
		} else high = middle - 1;
	}
	return page
		? ok(page)
		: err(
				new Error(
					"Concise context identity/envelope cannot fit the 16KiB byte budget. Use responseFormat: full or --format full; no mutation occurred.",
				),
			);
};

export namespace Planner {
	/** Rebuild/hash selected rendered content per call: no held snapshot or server session. */
	export const getContextPage = async (
		basePath: string,
		taskIdInput: string,
		options: ContextPageOptions = {},
	): Promise<Result<ContextPage>> => {
		const parsed = ContextPageOptionsSchema.safeParse(options);
		if (!parsed.success)
			return err(
				new Error(
					`Invalid concise context options: ${parsed.error.message.slice(0, 200)}`,
				),
			);
		const { sections: requested, cursor: cursorText, ...opts } = parsed.data;
		const sections = CONTEXT_SECTIONS.filter((section) =>
			requested.includes(section),
		);
		const cursor = decodeCursor(cursorText);
		if (!cursor.ok) return cursor;
		const id = await Tasks.resolveTaskId(basePath, taskIdInput);
		if (!id.ok)
			return err(
				new Error("Cannot resolve context task; check the id and retry."),
			);
		const task = await Tasks.getTask(basePath, id.value);
		if (!task.ok || !task.value)
			return err(
				new Error("Cannot read context task; check the id and retry."),
			);
		const taskId = task.value.id;
		const binding = await digest(JSON.stringify({ taskId, sections, ...opts }));
		if (!binding.ok)
			return err(
				new Error("Cannot fingerprint context options; retry the read."),
			);
		if (cursor.value && cursor.value.binding !== binding.value)
			return invalidCursor();
		const rendered = await readContextSections(
			basePath,
			task.value,
			opts,
			sections,
			true,
		);
		if (!rendered.ok) return rendered;
		let markdown = "";
		const ends = new Map<ContextSection, number>();
		for (const item of rendered.value) {
			if (item.markdown !== null) {
				if (markdown.length) markdown += "\n\n";
				markdown += item.markdown;
				ends.set(item.section, markdown.length);
			} else ends.set(item.section, 0);
		}
		const revision = await digest(JSON.stringify(markdown));
		if (!revision.ok)
			return err(
				new Error("Cannot fingerprint context content; retry the read."),
			);
		if (cursor.value && cursor.value.revision !== revision.value)
			return err(
				new Error(
					"Stale context cursor: selected content changed; restart without cursor.",
				),
			);
		const offset = cursor.value?.offset ?? 0;
		if (
			cursor.value &&
			(offset >= markdown.length || boundary(markdown, offset) !== offset)
		)
			return invalidCursor();
		return packContextPage({
			taskId,
			revision: revision.value,
			binding: binding.value,
			offset,
			markdown,
			sections,
			ends,
		});
	};
}
