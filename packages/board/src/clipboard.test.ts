import { describe, expect, it } from "bun:test";
import { Clipboard } from "./clipboard";

describe("Clipboard.write", () => {
	it("writes via the native writer and reports the native method", async () => {
		let captured = "";
		const native: Clipboard.NativeWriter = async (text) => {
			captured = text;
			return true;
		};
		const result = await Clipboard.write("the brief", { native });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe("native");
		expect(captured).toBe("the brief");
	});

	it("falls back to OSC 52 when the native writer fails", async () => {
		let osc52Text = "";
		const native: Clipboard.NativeWriter = async () => false;
		const osc52: Clipboard.Osc52Writer = {
			isOsc52Supported: () => true,
			copyToClipboardOSC52: (text) => {
				osc52Text = text;
				return true;
			},
		};
		const result = await Clipboard.write("via escape", { native, osc52 });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe("osc52");
		expect(osc52Text).toBe("via escape");
	});

	it("errors when neither native nor OSC 52 can write", async () => {
		const native: Clipboard.NativeWriter = async () => false;
		const osc52: Clipboard.Osc52Writer = {
			isOsc52Supported: () => false,
			copyToClipboardOSC52: () => false,
		};
		const result = await Clipboard.write("nowhere", { native, osc52 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toBe("clipboard unavailable");
	});

	it("errors on empty text without invoking any writer", async () => {
		let called = false;
		const native: Clipboard.NativeWriter = async () => {
			called = true;
			return true;
		};
		const result = await Clipboard.write("", { native });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toBe("nothing to copy");
		expect(called).toBe(false);
	});
});

describe("Clipboard.nativeCommands", () => {
	it("uses pbcopy on darwin", () => {
		expect(Clipboard.nativeCommands("darwin")).toEqual([
			{ command: "pbcopy", args: [] },
		]);
	});

	it("prefers wl-copy on wayland linux, then falls back to xclip/xsel", () => {
		const cmds = Clipboard.nativeCommands("linux", {
			WAYLAND_DISPLAY: "wayland-0",
		} as NodeJS.ProcessEnv);
		expect(cmds.map((c) => c.command)).toEqual(["wl-copy", "xclip", "xsel"]);
	});

	it("omits wl-copy without a wayland display", () => {
		const cmds = Clipboard.nativeCommands("linux", {} as NodeJS.ProcessEnv);
		expect(cmds.map((c) => c.command)).toEqual(["xclip", "xsel"]);
	});
});
