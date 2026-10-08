import { z } from "zod";
import { err, ok, type Result } from "./result";
import type { Task } from "./schemas";

export const ResponseFormatSchema = z.enum(["concise", "full"]);
export const QUEUE_BYTES = 16 * 1024;
export const RECEIPT_BYTES = 2 * 1024;
export const serializedBytes = (value: unknown): number =>
	new TextEncoder().encode(JSON.stringify(value)).length;
const FULL_READ = "kabane_get with id; CLI: kabane show <id> --json";
const IDENTITY_ERROR =
	"Concise identity cannot fit the byte budget; no mutation occurred. Use responseFormat: full or --format full.";

/** Never split a Unicode code point; JSON escaping is checked on the final object. */
const preview = (text: string, cap: number): string => {
	let out = "";
	let bytes = 0;
	const encoder = new TextEncoder();
	for (const char of text) {
		const size = encoder.encode(JSON.stringify(char)).length - 2;
		if (bytes + size > cap) break;
		out += char;
		bytes += size;
	}
	return out;
};

const summary = (task: Task, cap = 256) => {
	const fields = {
		title: task.title,
		kind: task.kind,
		assignee: task.assignee,
		scopeUri: task.scopeUri,
	};
	const truncatedFields: string[] = [];
	const title = preview(fields.title, cap);
	const kind = preview(fields.kind, Math.min(cap, 64));
	const assignee =
		fields.assignee === undefined
			? undefined
			: preview(fields.assignee, Math.min(cap, 128));
	const scopeUri =
		fields.scopeUri === undefined ? undefined : preview(fields.scopeUri, cap);
	for (const [key, value] of Object.entries({
		title,
		kind,
		assignee,
		scopeUri,
	}))
		if (value !== fields[key as keyof typeof fields]) truncatedFields.push(key);
	return {
		id: task.id,
		shortId: task.shortId,
		title,
		state: task.state,
		kind,
		priority: task.priority,
		assignee,
		scopeUri,
		...(truncatedFields.length ? { truncatedFields } : {}),
	};
};
export type TaskSummary = ReturnType<typeof summary>;

export const taskSummary = (
	task: Task,
	maxBytes = QUEUE_BYTES - 1024,
): Result<TaskSummary> => {
	for (const cap of [256, 128, 64, 32, 16, 0]) {
		const projected = summary(task, cap);
		if (serializedBytes(projected) <= maxBytes) return ok(projected);
	}
	return err(new Error(IDENTITY_ERROR));
};

const receiptProjection = (task: Task, cap: number) => {
	const title = preview(task.title, cap);
	const receipt = {
		id: task.id,
		shortId: task.shortId,
		title,
		state: task.state,
		version: task.version ?? 1,
		...(title !== task.title ? { truncatedFields: ["title"] } : {}),
		fullRead: FULL_READ,
	};
	return receipt;
};

export const taskReceipt = (task: Task) => {
	for (const cap of [128, 64, 32, 16, 0]) {
		const projected = receiptProjection(task, cap);
		if (serializedBytes(projected) <= RECEIPT_BYTES) return ok(projected);
	}
	return err(new Error(IDENTITY_ERROR));
};

export const QUEUE_OMISSIONS = [
	"description",
	"provenance",
	"verification",
	"history",
	"other task fields",
];
export const QUEUE_FULL_READ = FULL_READ;
