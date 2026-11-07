import { z } from "zod";

const ItemTextSchema = z.string().trim().min(1).max(1000);
/** A handle (`JCAB-12.3`), a ULID, or the `id:<ULID>` an item's line ends with. */
const ItemRefSchema = z.string().trim().min(1);
const PositionSchema = z.number().int().min(1);

export const AddSchema = z.object({
	id: z.string().min(1),
	items: z.array(ItemTextSchema).min(1).max(50),
	position: PositionSchema.optional(),
});
export type AddInput = z.input<typeof AddSchema>;

export const TickSchema = z.object({
	items: z.array(ItemRefSchema).min(1).max(50),
	done: z.boolean().default(true),
});
export type TickInput = z.input<typeof TickSchema>;

export const EditSchema = z
	.object({
		item: ItemRefSchema,
		text: ItemTextSchema.optional(),
		position: PositionSchema.optional(),
		remove: z.boolean().default(false),
	})
	.superRefine((value, ctx) => {
		const changes = value.text !== undefined || value.position !== undefined;
		if (value.remove ? changes : !changes)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Supply text, position or both; or remove: true alone.",
			});
	});
export type EditInput = z.input<typeof EditSchema>;

/** A `task_checklist_items` row as stored: the module's own reads, never its public shape. */
export type ChecklistItem = {
	id: string;
	task_id: string;
	text: string;
	rank: string;
	done_at: string | null;
	done_by: string | null;
	removed_at: string | null;
	created_at: string;
	updated_at: string;
	updated_by: string;
	version: number;
	visibility: string;
};

/** An item as every surface sees it, CLI JSON included: camelCase, with its handle. */
export type ChecklistItemView = {
	id: string;
	taskId: string;
	text: string;
	done: boolean;
	doneAt?: string;
	doneBy?: string;
	/** Set only on the item a remove returns; lists never include removed items. */
	removedAt?: string;
	/** The fractional key the list is ordered by, then the id. */
	rank: string;
	createdAt: string;
	updatedAt: string;
	updatedBy: string;
	version: number;
	visibility: string;
	/** `JCAB-12.3`: the issue's short id and the item's ordinal on it, in creation order. */
	handle: string;
	ordinal: number;
	shortId?: string;
};

export type ChecklistProgress = { done: number; total: number };

/** What a write returns: the items it changed, and its issue's checklist after it. */
export type ChecklistChange = {
	items: ChecklistItemView[];
	/** The issue's short id, or its ULID when it has none. */
	issue: string;
	progress: ChecklistProgress;
};
