// What the board does to the task in hand: writes its state, copies its brief, opens its linked
// issue. Each says how it went in the footer, never silent.
import { useRenderer } from "@opentui/react";
import { useCallback } from "react";
import { Clipboard } from "./clipboard";
import { BoardData } from "./data";
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

/** The runner for the task effects; `next` is the post-reduce state a reload merges into. */
export const useTaskActions = ({
	basePath,
	setNotice,
	reload,
}: {
	basePath: string;
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
			}
		},
		[basePath, write, copy, openLink],
	);
};
