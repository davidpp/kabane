// What was sent from a prompt this session, and the `up`/`down` walk back through it. A session
// buffer, never persisted. The position counts from the END, so a new prompt arriving does not shift
// a walk in progress; 0 is out of the walk, on an empty buffer.
export namespace PromptHistory {
	// Prompts kept for recall.
	const CAP = 50;

	export const push = (
		history: readonly string[],
		text: string,
	): readonly string[] => [...history, text].slice(-CAP);

	/** `up` is +1 (back), `down` -1: the text to show and where the walk now is. */
	export const step = (
		history: readonly string[],
		at: number,
		delta: 1 | -1,
	): { text: string; at: number } => {
		const next = Math.min(history.length, Math.max(0, at + delta));
		return {
			text: next === 0 ? "" : (history[history.length - next] ?? ""),
			at: next,
		};
	};
}
