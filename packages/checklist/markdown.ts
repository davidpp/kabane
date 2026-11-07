import type {
	ChecklistChange,
	ChecklistItemView,
	ChecklistProgress,
	EditInput,
} from "./schema";

const singleLine = (text: string): string =>
	text.replace(/\s*[\r\n]+\s*/g, " ");

const fraction = (progress: ChecklistProgress): string =>
	`${progress.done}/${progress.total}`;

/** One item's line. A handle can shift after sync; the ULID at the end never does. */
export const itemMarkdown = (item: ChecklistItemView): string =>
	`- [${item.done ? "x" : " "}] ${item.handle} ${singleLine(item.text)} id:${item.id}`;

/** The heading with its progress, then one line per item; null for no items. */
export const checklistMarkdown = (items: ChecklistItemView[]): string | null =>
	items.length
		? `## Checklist ${fraction({
				done: items.filter((item) => item.done).length,
				total: items.length,
			})}\n\n${items.map(itemMarkdown).join("\n")}`
		: null;

/** A write's one-line receipt: `JCAB-12 3/5 · ticked JCAB-12.2, JCAB-12.3`. */
export const changeReceipt = (
	change: ChecklistChange,
	verb: string,
	withIds = false,
): string => {
	const items = change.items.map((item) =>
		withIds ? `${item.handle} id:${item.id}` : item.handle,
	);
	return `${change.issue} ${fraction(change.progress)} · ${verb} ${items.join(", ")}`;
};

/** What an edit did, worded for its receipt; `moved … to <n>` follows the handle. */
export const editReceipt = (
	change: ChecklistChange,
	edit: EditInput,
): string => {
	if (edit.remove) return changeReceipt(change, "removed");
	const verb = edit.text === undefined ? "moved" : "edited";
	const moved =
		edit.position === undefined
			? ""
			: `${edit.text === undefined ? "" : " and moved"} to ${edit.position}`;
	return `${changeReceipt(change, verb)}${moved}`;
};
