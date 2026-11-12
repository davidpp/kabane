import { z } from "zod";

/**
 * Scope URI schemas.
 *
 * `kabane://scope/<scopeId>?<extensions>` is the canonical context identifier a
 * task carries. Core parses and formats it and never resolves it: a host
 * decides what a scope id means. `jake://scope/…`, the scheme before schema 10,
 * is read as the same scope and never written (`ScopeUri.LEGACY_PREFIX`).
 */

export const ParsedScopeUriSchema = z.object({
	scheme: z.literal("kabane"),
	namespace: z.literal("scope"),
	scopeId: z.string().min(1),
	extensions: z.record(z.string()).optional(),
});
export type ParsedScopeUri = z.infer<typeof ParsedScopeUriSchema>;

export const ScopeUriPartsSchema = z.object({
	scopeId: z.string().min(1),
	extensions: z.record(z.string()).optional(),
});
export type ScopeUriParts = z.infer<typeof ScopeUriPartsSchema>;

export const ScopeRefRoleSchema = z.enum(["primary", "related", "parent"]);
export type ScopeRefRole = z.infer<typeof ScopeRefRoleSchema>;

export const ScopeRefSchema = z.object({
	scopeUri: z.string(),
	role: ScopeRefRoleSchema.optional().default("related"),
});
export type ScopeRef = z.infer<typeof ScopeRefSchema>;

export const ScopeQuerySchema = z.object({
	scopeId: z.string().optional(),
	extensions: z.record(z.string()).optional(),
});
export type ScopeQuery = z.infer<typeof ScopeQuerySchema>;
