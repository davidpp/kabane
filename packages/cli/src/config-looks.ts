// How the device keys of `config.json` read on a generated settings screen, as an extension's
// `looks` say for its own namespace. The choices `ConfigSchema` keeps open on purpose, so a config
// from a newer kabane still loads, come from what this build ships.
import { Harnesses } from "@cabane/acp/harnesses";
import type { Settings } from "@cabane/extension";
import { Extensions } from "./extensions";

export const DEVICE_LOOKS: Settings.Looks = {
	copilot: { label: "copilot", group: "Copilot" },
	"copilot.harness": {
		label: "harness",
		group: "Copilot",
		options: Harnesses.IDS,
	},
	"copilot.model": { label: "model", group: "Copilot", none: "the pinned one" },
	"copilot.command": {
		label: "adapter command",
		group: "Copilot",
		none: "the pinned adapter",
	},
	"copilot.args": { label: "adapter arguments", group: "Copilot" },
	harness: { label: "sessions", group: "Sessions" },
	"harness.mode": { label: "start mode", group: "Sessions", none: "auto" },
	sync: { label: "sync", group: "Sync" },
	"sync.enabled": { label: "sync on", group: "Sync" },
	"sync.url": { label: "hub URL", group: "Sync" },
	"sync.token": { label: "hub token", group: "Sync" },
	"sync.headers": { label: "edge headers", group: "Sync" },
	"sync.batchBytes": { label: "push chunk (bytes)", group: "Sync" },
	"sync.deviceId": { label: "first device id", group: "Sync" },
	extensions: {
		label: "extensions",
		group: "Board",
		options: Extensions.names,
	},
	updates: { label: "updates", group: "Board" },
	"updates.check": { label: "release notices", group: "Board" },
	timezone: { label: "timezone", group: "Board", none: "the system's" },
	actor: { label: "actor", group: "Identity" },
	deviceId: { label: "device id", group: "Identity" },
};
