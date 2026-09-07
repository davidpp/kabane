import { z } from "zod";

/**
 * Scope URI schemas.
 *
 * `jake://scope/<scopeId>?<extensions>` is the canonical context identifier a
 * task carries. The scheme is kept for wire compatibility with existing data;
 * Cabane parses and formats it and never resolves it — a host decides what a
 * scope id means.
 */

export const ParsedScopeUriSchema = z.object({
	scheme: z.literal("jake"),
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
