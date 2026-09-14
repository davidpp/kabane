/**
 * Linked-Issue Schema
 *
 * A relationship between a Cabane task and the team-facing issue it points at
 * in an external tracker. IDENTITY ONLY: provider, key, url, title. The
 * external issue's content is deliberately NOT stored here — whatever matters
 * about it belongs in the task's own description, written once when the link
 * is made. Nothing here is a copy of someone else's state, so nothing here can
 * go stale, and no consumer needs to render staleness.
 */

import { z } from "zod";

/** Suggested providers. The stored provider remains a soft string. */
export const UPSTREAM_PROVIDERS = ["linear", "github"] as const;

const isWebUrl = (value: string): boolean => {
	try {
		const protocol = new URL(value).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
};

/** Full linked-issue record. */
export const UpstreamLinkSchema = z
	.object({
		id: z.string().min(1),
		taskId: z.string().min(1),
		provider: z.string().trim().min(1),
		externalId: z.string().trim().min(1),
		identifier: z.string().trim().min(1).optional(),
		url: z
			.string()
			.url()
			.refine(isWebUrl, "Upstream URL must use HTTP or HTTPS"),
		/** Written once when the link is made. Never re-read from the provider. */
		title: z.string().trim().min(1),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
	})
	.strict();
export type UpstreamLink = z.infer<typeof UpstreamLinkSchema>;

/** Compact link metadata for list and row indicators. */
export const UpstreamSummarySchema = z
	.object({
		taskId: z.string().min(1),
		provider: z.string().trim().min(1),
		identifier: z.string().trim().min(1).optional(),
	})
	.strict();
export type UpstreamSummary = z.infer<typeof UpstreamSummarySchema>;

/**
 * Input for linking a task to an external issue.
 * Local identity and bookkeeping timestamps are storage-owned.
 */
export const UpsertUpstreamLinkInputSchema = UpstreamLinkSchema.omit({
	id: true,
	createdAt: true,
	updatedAt: true,
});
export type UpsertUpstreamLinkInput = z.infer<
	typeof UpsertUpstreamLinkInputSchema
>;
