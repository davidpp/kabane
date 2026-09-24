// System clipboard writer for the board's copy-brief action. Adapted from zact-v2's ui-otui clipboard
// (native OS command first, OSC 52 escape as the fallback that survives ssh/tmux). Both writers are
// injectable so tests never shell out or touch a real renderer.
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { err, ok, type Result } from "@cabane/core";

export namespace Clipboard {
	type WriteMethod = "native" | "osc52";

	// The OpenTUI renderer exposes both of these; injected as a narrow interface so the copy path can
	// be tested without a live renderer.
	export type Osc52Writer = {
		isOsc52Supported: () => boolean;
		copyToClipboardOSC52: (text: string) => boolean;
	};

	// Writes to the OS clipboard, resolving true on success. Injectable so tests skip the subprocess.
	export type NativeWriter = (text: string) => Promise<boolean>;

	type Command = { command: string; args: readonly string[] };

	const runCommand = (
		{ command, args }: Command,
		input: string,
	): Promise<boolean> =>
		new Promise((resolve) => {
			const child = spawn(command, [...args], {
				stdio: ["pipe", "ignore", "ignore"],
			});
			child.on("error", () => resolve(false));
			child.on("close", (code) => resolve(code === 0));
			child.stdin.end(input);
		});

	// The OS clipboard commands to try in order, per platform (Wayland before X11 on linux).
	export const nativeCommands = (
		os: NodeJS.Platform = platform(),
		env: NodeJS.ProcessEnv = process.env,
	): readonly Command[] => {
		if (os === "darwin") return [{ command: "pbcopy", args: [] }];
		if (os === "win32")
			return [
				{
					command: "powershell.exe",
					args: [
						"-NonInteractive",
						"-NoProfile",
						"-Command",
						"[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
					],
				},
			];
		if (os !== "linux") return [];
		const commands: Command[] = [];
		if (env.WAYLAND_DISPLAY) commands.push({ command: "wl-copy", args: [] });
		commands.push({ command: "xclip", args: ["-selection", "clipboard"] });
		commands.push({ command: "xsel", args: ["--clipboard", "--input"] });
		return commands;
	};

	const writeNative: NativeWriter = async (text) => {
		for (const command of nativeCommands()) {
			if (await runCommand(command, text)) return true;
		}
		return false;
	};

	// Try the native OS clipboard first, then the OSC 52 escape (works over ssh/tmux where no local
	// clipboard command exists). Returns which method won, or an error naming why nothing stuck.
	export const write = async (
		text: string,
		deps: { osc52?: Osc52Writer; native?: NativeWriter } = {},
	): Promise<Result<WriteMethod>> => {
		if (text.length === 0) return err(new Error("nothing to copy"));
		const native = deps.native ?? writeNative;
		if (await native(text)) return ok("native");
		const osc52 = deps.osc52;
		if (osc52?.isOsc52Supported() && osc52.copyToClipboardOSC52(text))
			return ok("osc52");
		return err(new Error("clipboard unavailable"));
	};
}
