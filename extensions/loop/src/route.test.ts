import { describe, expect, it } from "bun:test";
import { LoopConfig } from "./config";
import { Route } from "./route";

const config = (input: LoopConfig.Input = {}): LoopConfig.Config =>
	LoopConfig.Schema.parse(input);

describe("Route.of", () => {
	it("runs on the run's implementer with no tags, and ignores tags of no kind it reads", () => {
		expect(Route.of(["docs", "lens:quality"], config())).toEqual({
			harness: "claude",
			notes: [],
		});
	});

	it("reads a tier, a harness pin and an agent, which combine", () => {
		expect(Route.of(["tier:codex/fast", "agent:board-ui"], config())).toEqual({
			harness: "codex",
			tier: "fast",
			agent: "board-ui",
			notes: [],
		});
		expect(
			Route.of(["tier:frontier"], config({ implementer: "codex" })),
		).toEqual({ harness: "codex", tier: "frontier", notes: [] });
	});

	it("knows the tiers loop.tiers adds", () => {
		expect(
			Route.of(["tier:docs"], config({ tiers: { claude: { docs: "haiku" } } })),
		).toMatchObject({ tier: "docs", notes: [] });
	});

	it("falls back, with a note, on an unknown tier, an unknown harness and a second tag", () => {
		expect(Route.of(["tier:cheap"], config())).toEqual({
			harness: "claude",
			notes: [
				"tier:cheap: cheap is not a tier (frontier, balanced, fast), so it runs on the run's model",
			],
		});
		expect(Route.of(["tier:cobol/fast"], config())).toEqual({
			harness: "claude",
			tier: "fast",
			notes: [
				"tier:cobol/fast: cobol is not a harness (claude, codex, gemini), so it runs on claude",
			],
		});
		expect(
			Route.of(["agent:a", "tier:fast", "agent:b", "tier:frontier"], config()),
		).toEqual({
			harness: "claude",
			tier: "fast",
			agent: "a",
			notes: [
				"tier:frontier ignored: the first tag of its kind wins",
				"agent:b ignored: the first tag of its kind wins",
			],
		});
		expect(Route.of(["agent:"], config()).notes).toEqual([
			"agent: names no agent",
		]);
	});
});

describe("Route.model", () => {
	const tiers = { claude: { fast: "haiku", frontier: "opus" } };

	it("takes the tier over the run's model", () => {
		expect(
			Route.model(config({ model: "sonnet", tiers }), "claude", {
				tier: "fast",
			}),
		).toEqual({ model: "haiku", source: "tier", tier: "fast", notes: [] });
	});

	it("takes the run's model without a tier, a tier it names included", () => {
		expect(
			Route.model(config({ model: "sonnet", tiers }), "claude", {}),
		).toEqual({ model: "sonnet", source: "run", notes: [] });
		expect(
			Route.model(config({ model: "frontier", tiers }), "claude", {}),
		).toEqual({ model: "opus", source: "run", tier: "frontier", notes: [] });
		expect(Route.model(config(), "claude", {})).toEqual({
			source: "default",
			notes: [],
		});
	});

	it("keeps an agent's pinned model over the tier and the run's model, and says so", () => {
		expect(
			Route.model(
				config({ model: "sonnet", tiers }),
				"claude",
				{ tier: "fast", agent: "board-ui" },
				"opus",
			),
		).toEqual({
			model: "opus",
			source: "agent",
			notes: ["tier fast not applied: agent board-ui pins opus"],
		});
		expect(
			Route.model(
				config({ model: "sonnet" }),
				"claude",
				{ agent: "board-ui" },
				"opus",
			).notes,
		).toEqual(["sonnet not applied: agent board-ui pins opus"]);
		// An agent with no pin takes the tier.
		expect(
			Route.model(config({ tiers }), "claude", {
				tier: "fast",
				agent: "board-ui",
			}),
		).toMatchObject({ model: "haiku", source: "tier" });
	});

	it("falls back to the run's model, with a note, when the tier names no model on the harness", () => {
		expect(
			Route.model(config({ model: "sonnet", tiers }), "codex", {
				tier: "fast",
			}),
		).toEqual({
			model: "sonnet",
			source: "run",
			notes: [
				"tier fast names no model for codex (loop.tiers.codex.fast), so it runs on sonnet",
			],
		});
		expect(Route.model(config({ tiers }), "codex", { tier: "fast" })).toEqual({
			source: "default",
			notes: [
				"tier fast names no model for codex (loop.tiers.codex.fast), so it runs on codex's own default",
			],
		});
	});
});
