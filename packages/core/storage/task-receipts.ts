import { err, type Result } from "../result";
import { type TaskUpdate, TaskUpdateSchema } from "../schemas";
import { taskReceipt } from "../task-output";
import {
	derivePrefix,
	normalizeOptionalScopeUri,
	prospectiveShortId,
} from "./helpers";
import { Planner as Tasks } from "./tasks";

export namespace Planner {
	/** Preflight required identity and prospective state/version before any write.
	 * Imported IDs/labels are not assumed to fit; full mode remains lossless.
	 */
	export const updateTaskReceipt = async (
		basePath: string,
		id: string,
		updates: TaskUpdate,
	): Promise<
		Result<Extract<ReturnType<typeof taskReceipt>, { ok: true }>["value"]>
	> => {
		const validated = TaskUpdateSchema.safeParse(updates);
		if (!validated.success)
			return err(
				new Error(
					"Invalid concise updates; check state, kind, priority and field types. No mutation occurred.",
				),
			);
		const current = await Tasks.getTask(basePath, id);
		if (!current.ok) return current;
		if (!current.value)
			return err(new Error("No task found; no mutation occurred."));
		let shortId = current.value.shortId;
		if (updates.scopeUri !== undefined) {
			const scope = normalizeOptionalScopeUri(updates.scopeUri);
			if (!scope.ok)
				return err(
					new Error(
						"Invalid concise scope; check the scope URI. No mutation occurred.",
					),
				);
			const prefix = derivePrefix(scope.value);
			if (!prefix.ok)
				return err(
					new Error(
						"Invalid concise scope prefix; check the scope URI. No mutation occurred.",
					),
				);
			const prospective = await prospectiveShortId(basePath, prefix.value);
			if (!prospective.ok)
				return err(
					new Error(
						"Cannot preflight the scope label; retry the update. No mutation occurred.",
					),
				);
			shortId = prospective.value;
		}
		const preflight = taskReceipt({
			...current.value,
			shortId,
			title: updates.title ?? current.value.title,
			state: updates.state ?? current.value.state,
			version: (current.value.version ?? 1) + 1,
		});
		if (!preflight.ok) return preflight;
		const updated = await Tasks.updateTask(basePath, current.value.id, updates);
		if (!updated.ok) return updated;
		if (!updated.value)
			return err(
				new Error("Task disappeared during update; restart the read."),
			);
		const receipt = taskReceipt(updated.value);
		if (!receipt.ok)
			return err(
				new Error(
					"Task was updated, but its identity changed and no longer fits a concise receipt. Read it in full mode before retrying.",
				),
			);
		return receipt;
	};
}
