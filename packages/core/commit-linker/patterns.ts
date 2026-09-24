/**
 * Commit Message Patterns
 *
 * Regex patterns for extracting task IDs from commit messages.
 * Follows Linear/GitHub conventions.
 */

import { firstGroups } from "../regex";

/**
 * Task ID pattern - matches short IDs like JAKE-123, ALL-45
 */
export const TASK_ID_PATTERN = /\b([A-Z]{2,4}-\d+)\b/g;

/**
 * Patterns for different commit message formats
 */
export const PATTERNS = {
	/**
	 * Conventional commit format
	 * Examples:
	 * - fix(JAKE-123): resolve auth bug
	 * - feat(JAKE-123, JAKE-124): add login and signup
	 */
	conventional:
		/^(?:feat|fix|docs|style|refactor|test|chore|build|ci|perf|revert)\(([^)]+)\)/i,

	/**
	 * Reference markers in commit body
	 * Examples:
	 * - Refs: JAKE-123
	 * - refs #JAKE-45
	 * - Ref: JAKE-1, JAKE-2
	 */
	references: /(?:refs?:?\s*#?)([A-Z]{2,4}-\d+(?:\s*,\s*[A-Z]{2,4}-\d+)*)/gi,

	/**
	 * Close/fix/resolve keywords (marks task as done)
	 * Examples:
	 * - closes JAKE-123
	 * - Fixes JAKE-45
	 * - resolves JAKE-789
	 */
	closes: /(?:close[s]?|fix(?:es)?|resolve[s]?)\s+([A-Z]{2,4}-\d+)/gi,
} as const;

/**
 * Parse task IDs from conventional commit format
 */
export function parseConventionalCommit(message: string): string[] {
	const match = message.match(PATTERNS.conventional);
	if (!match) return [];

	// Extract IDs from parentheses content (e.g., "JAKE-123, JAKE-124")
	const content = match[1];
	if (!content) return [];

	const ids = content.match(TASK_ID_PATTERN);
	return ids || [];
}

/**
 * Parse task IDs from reference markers
 */
export function parseReferences(message: string): string[] {
	// Extract all IDs from each match (handles "JAKE-1, JAKE-2")
	return firstGroups(message, PATTERNS.references).flatMap(
		(group) => group.match(TASK_ID_PATTERN) ?? [],
	);
}

/**
 * Parse task IDs with "closes" semantics
 */
export function parseCloseKeywords(message: string): string[] {
	return firstGroups(message, PATTERNS.closes);
}

/**
 * Parse all task IDs from a commit message
 * Returns unique IDs
 */
export function parseAllTaskIds(message: string): string[] {
	const ids = new Set<string>();

	// Check conventional commit format first (most specific)
	for (const id of parseConventionalCommit(message)) {
		ids.add(id);
	}

	// Check reference markers
	for (const id of parseReferences(message)) {
		ids.add(id);
	}

	// Check close keywords
	for (const id of parseCloseKeywords(message)) {
		ids.add(id);
	}

	// Fallback: any task ID pattern in the message
	const allMatches = message.match(TASK_ID_PATTERN);
	if (allMatches) {
		for (const id of allMatches) {
			ids.add(id);
		}
	}

	return Array.from(ids);
}

/**
 * Check if a commit message has "closes" semantics for a specific task ID
 */
export function hasCloseKeyword(message: string, taskId: string): boolean {
	const closedIds = parseCloseKeywords(message);
	return closedIds.some((id) => id.toUpperCase() === taskId.toUpperCase());
}
