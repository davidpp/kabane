// What the board does to the task in hand: writes its state, answers its decisions, ticks its
// checklist, copies its brief, opens its linked issue. Each says how it went in the footer, never
// silent.
import { useRenderer } from "@opentui/react";
import { useCallback } from "react";
import type { BoardStore } from "./board-store";
import { BoardChecklist } from "./checklist";
import { Clipboard } from "./clipboard";
import { BoardData } from "./data";
import { BoardDecisions } from "./decisions";
import { Launcher } from "./launcher";
import { BoardNav } from "./nav";
import { flash, type Outcome, type SetNotice } from "./notice";

const TASK_EFFECTS = [
	"setState",
	"markDone",
	"markReviewed",
	"applyUndo",
	"copy",
	"openLink",
	"answerDecision",
	"tickItem",
] as const;
export type TaskEffect = Extract<
	BoardNav.Effect,
	{ type: (typeof TASK_EFFECTS)[number] }
>;
export const isTaskEffect = BoardNav.effectsOf(TASK_EFFECTS);

// The tracker write a mutation effect asks for.
const writeOf = (
	basePath: string,
	effect: Extract<
		TaskEffect,
		{ type: "setState" | "markDone" | "markReviewed" | "applyUndo" }
	>,
): Promise<Outcome> => {
	switch (effect.type) {
		case "setState":
			return BoardData.setTaskState(basePath, effect.id, effect.state);
		case "markDone":
			return BoardData.markDone(basePath, effect.id);
		case "markReviewed":
			return BoardData.markReviewed(basePath, effect.id);
		case "applyUndo":
			return BoardData.applyUndo(basePath, effect.id, effect.patch);
	}
};

// A decision answered on the detail view, as `kabane_answer` answers it. The reload brings the
// issue's records back without it, and the issue in its new section when the last one moved it to
// `next`; a failed write puts the decision back in front of the human.
const useDecide = (
	basePath: string,
	{ update }: Pick<BoardStore, "update">,
	setNotice: SetNotice,
	reload: (s: BoardNav.BoardState) => Promise<void>,
) =>
	useCallback(
		async (
			next: BoardNav.BoardState,
			effect: Extract<TaskEffect, { type: "answerDecision" }>,
		): Promise<void> => {
			const res = await BoardData.answerDecision(basePath, {
				question: effect.questionId,
				answer: effect.answer,
				reasoning: effect.reasoning,
			});
			if (!res.ok) {
				update((prev) => BoardDecisions.withFailed(prev, effect.questionId));
				setNotice({ text: res.error.message, tone: "error" });
				return;
			}
			// The handle names the issue before its ordinal (`JREP-7:2`), a ULID where it has no short id.
			const issue = effect.handle.replace(/:\d+$/, "");
			setNotice({
				text: res.value.moved
					? `${effect.handle} answered · ${issue} → next`
					: `${effect.handle} answered`,
				tone: "success",
			});
			await reload(next);
		},
		[basePath, setNotice, reload, update],
	);

// A checklist item ticked on the detail view, as `kabane_checklistTick` ticks it. The item already
// shows the press; the reload brings the records and the card's count up to it, and a failed write
// shows the item as it was.
const useTick = (
	basePath: string,
	{ update }: Pick<BoardStore, "update">,
	setNotice: SetNotice,
	reload: (s: BoardNav.BoardState) => Promise<void>,
) =>
	useCallback(
		async (
			next: BoardNav.BoardState,
			effect: Extract<TaskEffect, { type: "tickItem" }>,
		): Promise<void> => {
			const res = await BoardData.tickItem(
				basePath,
				effect.itemId,
				effect.done,
			);
			if (!res.ok) {
				update((prev) => BoardChecklist.withFailed(prev, effect.itemId));
				setNotice({ text: res.error.message, tone: "error" });
				return;
			}
			const { done, total } = res.value.progress;
			setNotice({
				text: `${effect.handle} ${effect.done ? "ticked" : "unticked"} · ${done}/${total}`,
				tone: "success",
			});
			await reload(next);
		},
		[basePath, setNotice, reload, update],
	);

/** The runner for the task effects; `next` is the post-reduce state a reload merges into. */
export const useTaskActions = ({
	basePath,
	store,
	setNotice,
	reload,
}: {
	basePath: string;
	// A decision whose write failed is asked again, and an item whose tick failed shows as it was.
	store: Pick<BoardStore, "update">;
	setNotice: SetNotice;
	reload: (s: BoardNav.BoardState) => Promise<void>;
}): ((next: BoardNav.BoardState, effect: TaskEffect) => void) => {
	const renderer = useRenderer();
	// A tracker write: flash the outcome, and reload so the board shows it. A write the reducer pushed
	// an undo entry for says so in its flash: every one but the undo's own reverse patch (no redo).
	const write = useCallback(
		async (
			next: BoardNav.BoardState,
			written: Promise<Outcome>,
			notice: string,
			undoable: boolean,
		): Promise<void> => {
			const res = await written;
			setNotice(
				undoable
					? { ...flash(res, notice), undoable: res.ok }
					: flash(res, notice),
			);
			await reload(next);
		},
		[setNotice, reload],
	);

	// Copy a task's exact assembled brief to the system clipboard, flashing the outcome in the footer.
	// Uses the raw BoardData.taskBrief string (what David pastes to agents), not the rendered markdown.
	const copy = useCallback(
		async (id: string): Promise<void> => {
			const brief = await BoardData.taskBrief(basePath, id);
			if (!brief.ok) {
				setNotice({ text: brief.error.message, tone: "error" });
				return;
			}
			const wrote = await Clipboard.write(renderer, brief.value);
			setNotice(
				wrote.ok
					? { text: "copied brief to clipboard", tone: "success" }
					: { text: wrote.error.message, tone: "error" },
			);
		},
		[basePath, renderer, setNotice],
	);

	// `O`: hand the task's linked issue to the OS. Several links open the first — the picker a rare
	// case would want costs a modal on the common one, and the detail brief lists them all anyway.
	// The clipboard leg of the chain gets this renderer so it can reach OSC 52 over ssh.
	const openLink = useCallback(
		async (id: string): Promise<void> => {
			const links = await BoardData.taskLinks(basePath, id);
			if (!links.ok) {
				setNotice({ text: links.error.message, tone: "error" });
				return;
			}
			const link = links.value[0];
			if (!link) {
				setNotice({ text: "no linked issue", tone: "error" });
				return;
			}
			const target = {
				provider: link.provider,
				identifier: link.identifier,
				url: link.url,
			};
			const opened = await Launcher.open(target, {
				copy: async (text) => (await Clipboard.write(renderer, text)).ok,
			});
			const name = Launcher.label(target);
			if (!opened.ok) {
				setNotice({ text: opened.error.message, tone: "error" });
				return;
			}
			setNotice(
				opened.value === "clipboard"
					? { text: `no opener · ${name} copied`, tone: "success" }
					: { text: `opening ${name} in ${link.provider}`, tone: "success" },
			);
		},
		[basePath, renderer, setNotice],
	);

	const decide = useDecide(basePath, store, setNotice, reload);
	const tick = useTick(basePath, store, setNotice, reload);

	return useCallback(
		(next: BoardNav.BoardState, effect: TaskEffect): void => {
			switch (effect.type) {
				case "setState":
				case "markDone":
				case "markReviewed":
				case "applyUndo":
					void write(
						next,
						writeOf(basePath, effect),
						effect.notice,
						effect.type !== "applyUndo",
					);
					return;
				case "copy":
					void copy(effect.id);
					return;
				case "openLink":
					void openLink(effect.id);
					return;
				case "answerDecision":
					void decide(next, effect);
					return;
				case "tickItem":
					void tick(next, effect);
			}
		},
		[basePath, write, copy, openLink, decide, tick],
	);
};
