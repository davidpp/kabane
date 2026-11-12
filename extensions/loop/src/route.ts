// What a subtask's tags ask of the claim that implements it: `tier:<name>` for how capable a model
// it needs, `tier:<harness>/<name>` to also pin the harness it runs on, and `agent:<name>` for the
// harness's own named agent to run as. A tag the run cannot honour never stops it: the claim runs on
// the fallback (the run's implementer, the run's model, no agent) and the trace says why.
import { Harnesses } from "@cabane/acp";
import { LoopConfig } from "./config";

export namespace Route {
	export type Route = {
		harness: Harnesses.Id;
		/** The tier a `tier:` tag names, when it is one the run knows. */
		tier?: string;
		/** The agent an `agent:` tag names. */
		agent?: string;
		/** Why a tag was not honoured, one line each, for the trace. */
		notes: string[];
	};

	const TIER = "tier:";
	const AGENT = "agent:";

	/** The route `tags` ask for, under a run configured as `config`. */
	export const of = (
		tags: readonly string[],
		config: Pick<LoopConfig.Config, "implementer" | "tiers">,
	): Route => {
		const notes: string[] = [];
		const route: Route = { harness: config.implementer, notes };
		const tiers = tags.filter((t) => t.startsWith(TIER));
		const agents = tags.filter((t) => t.startsWith(AGENT));
		const [tier, ...otherTiers] = tiers;
		const [agent, ...otherAgents] = agents;
		for (const extra of [...otherTiers, ...otherAgents])
			notes.push(`${extra} ignored: the first tag of its kind wins`);
		if (tier !== undefined) {
			const value = tier.slice(TIER.length);
			const at = value.indexOf("/");
			const pin = at === -1 ? undefined : value.slice(0, at);
			const name = at === -1 ? value : value.slice(at + 1);
			if (pin !== undefined) {
				if (Harnesses.isId(pin)) route.harness = pin;
				else
					notes.push(
						`${tier}: ${pin} is not a harness (${Harnesses.IDS.join(", ")}), so it runs on ${config.implementer}`,
					);
			}
			const names = LoopConfig.tierNames(config);
			if (names.includes(name)) route.tier = name;
			else
				notes.push(
					`${tier}: ${name || "(empty)"} is not a tier (${names.join(", ")}), so it runs on the run's model`,
				);
		}
		if (agent !== undefined) {
			const name = agent.slice(AGENT.length);
			if (name === "") notes.push(`${agent} names no agent`);
			else route.agent = name;
		}
		return route;
	};

	/** Where a claim's model comes from: its tier tag, the run's model, the agent's pin, or the harness. */
	export const SOURCES = ["tier", "run", "agent", "default"] as const;
	export type Source = (typeof SOURCES)[number];

	/**
	 * The model a claim runs on, where that came from, and why a choice fell back. An agent's pin is
	 * never asked for: the agent runs on it unasked.
	 */
	export type Model = {
		model?: string;
		source: Source;
		/** The tier the model was resolved from, its tag's or the run's. */
		tier?: string;
		notes: string[];
	};

	/**
	 * The model a claim on `harness` asks for: an agent that pins its own model keeps it (`pin`,
	 * from `Harnesses.agentDefinition`), else the claim's tier, else the run's model
	 * (`LoopConfig.resolveModel`), else the harness's own default. A tier with no model on this
	 * harness falls back to the run's model with a note.
	 */
	export const model = (
		config: Pick<LoopConfig.Config, "model" | "tiers">,
		harness: Harnesses.Id,
		route: { tier?: string; agent?: string },
		pin?: string,
	): Model => {
		const run = (): Model => {
			const resolved = LoopConfig.resolveModel(config, harness);
			return {
				...(resolved.model === undefined ? {} : { model: resolved.model }),
				source: resolved.source === "default" ? "default" : "run",
				...(resolved.tier ? { tier: resolved.tier } : {}),
				notes: resolved.note ? [resolved.note] : [],
			};
		};
		if (pin !== undefined) {
			const asked = route.tier ?? config.model;
			return {
				model: pin,
				source: "agent",
				notes:
					asked === undefined
						? []
						: [
								`${route.tier ? "tier " : ""}${asked} not applied: agent ${route.agent} pins ${pin}`,
							],
			};
		}
		if (route.tier === undefined) return run();
		const tiered = LoopConfig.resolveModel(config, harness, route.tier);
		if (tiered.source === "tier" && tiered.model !== undefined)
			return {
				model: tiered.model,
				source: "tier",
				tier: route.tier,
				notes: [],
			};
		const fallback = run();
		return {
			...fallback,
			notes: [
				`tier ${route.tier} names no model for ${harness} (loop.tiers.${harness}.${route.tier}), so it runs on ${fallback.model ?? `${harness}'s own default`}`,
				...fallback.notes,
			],
		};
	};
}
