/**
 * Private Upstream Link Schema
 *
 * A local relationship between a Jake implementation root and a team-wide
 * external work item. The snapshot is intentionally allowlisted: provider
 * credentials and arbitrary provider payloads never belong in Planner.
 */

import { z } from "zod";

/** Suggested providers. The stored provider remains a soft string. */
export const UPSTREAM_PROVIDERS = ["linear"] as const;

const isWebUrl = (value: string): boolean => {
	try {
		const protocol = new URL(value).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
};

/** Full private upstream-link record stored by Planner. */
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
		title: z.string().trim().min(1),
		description: z.string().optional(),
		state: z.string().optional(),
		externalUpdatedAt: z.string().datetime().optional(),
		refreshedAt: z.string().datetime(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
	})
	.strict();
export type UpstreamLink = z.infer<typeof UpstreamLinkSchema>;

/** Compact private-link metadata for list and card indicators. */
export const UpstreamSummarySchema = z
	.object({
		taskId: z.string().min(1),
		provider: z.string().trim().min(1),
		identifier: z.string().trim().min(1).optional(),
		refreshedAt: z.string().datetime(),
	})
	.strict();
export type UpstreamSummary = z.infer<typeof UpstreamSummarySchema>;

/**
 * Input for linking or refreshing an implementation.
 * Local identity and bookkeeping timestamps are storage-owned.
 */
export const UpsertUpstreamLinkInputSchema = UpstreamLinkSchema.omit({
	id: true,
	refreshedAt: true,
	createdAt: true,
	updatedAt: true,
});
export type UpsertUpstreamLinkInput = z.infer<
	typeof UpsertUpstreamLinkInputSchema
>;
