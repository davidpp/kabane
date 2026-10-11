// Several hosts behind one port. The board takes a single ActivitySource and a single Dispatcher; a
// host with more than one contributor merges them here, each under a name. Every id that crosses
// the port gets `<name>:` in front, so a card refresh, an events poll or a dispatch routes back to
// the contributor that minted it, and two contributors may reuse the same ids.
import { err, ok, type Result } from "@cabane/core";
import { createElement } from "react";
import type {
	ActivityCard,
	ActivitySource,
	CardHeader,
	Dispatcher,
	TriggerDescriptor,
} from "./ports";

type Named<T> = Readonly<Record<string, T>>;

const prefixed = (name: string, id: string): string => `${name}:${id}`;

// The contributor whose prefix `id` carries, and the id it minted.
const route = <T>(
	parts: Named<T>,
	id: string,
): { part: T; id: string } | undefined => {
	for (const [name, part] of Object.entries(parts)) {
		const prefix = prefixed(name, "");
		if (id.startsWith(prefix)) return { part, id: id.slice(prefix.length) };
	}
	return undefined;
};

const unrouted = (what: string, id: string): Error =>
	new Error(`No contributor owns ${what} "${id}"`);

// ISO-8601 timestamps sort as strings.
const newestFirst = (a: ActivityCard, b: ActivityCard): number =>
	b.startedAt.localeCompare(a.startedAt);

export namespace Activity {
	export const merge = (sources: Named<ActivitySource>): ActivitySource => ({
		// A failing source contributes no cards rather than blanking the others: the board reads
		// activity leniently on every poll (activity.ts), so an error here would only hide the rest.
		load: async () => {
			const loaded = await Promise.all(
				Object.entries(sources).map(async ([name, source]) => {
					const cards = await source.load();
					return cards.ok
						? cards.value.map((card) => ({
								...card,
								id: prefixed(name, card.id),
							}))
						: [];
				}),
			);
			return ok(loaded.flat().sort(newestFirst));
		},
		card: async (id) => {
			const routed = route(sources, id);
			if (!routed) return err(unrouted("card", id));
			// Without `card` the contributor's cards show as loaded, which null also means.
			if (!routed.part.card) return ok(null);
			const card = await routed.part.card(routed.id);
			return card.ok && card.value ? ok({ ...card.value, id }) : card;
		},
		events: async (id, afterSeq) => {
			const routed = route(sources, id);
			if (!routed) return err(unrouted("card", id));
			return routed.part.events
				? routed.part.events(routed.id, afterSeq)
				: ok([]);
		},
		act: async (id, actionId, input) => {
			const routed = route(sources, id);
			if (!routed) return err(unrouted("card", id));
			return routed.part.act
				? routed.part.act(routed.id, actionId, input)
				: err(new Error(`${id} takes no actions`));
		},
		dismiss: async (id) => {
			const routed = route(sources, id);
			if (!routed) return err(unrouted("card", id));
			// A contributor that keeps nothing to dismiss has nothing to forget.
			return routed.part.dismiss
				? routed.part.dismiss(routed.id)
				: ok(undefined);
		},
		// A question id is core's, not a contributor's, so every contributor hears it and the one whose
		// session asked notes it. The first failure is reported; the others still ran.
		answering: async (questionId) => {
			const noted = await Promise.all(
				Object.entries(sources).map(async ([name, source]) => {
					const result = source.answering
						? await source.answering(questionId)
						: ok(undefined);
					return result.ok
						? result
						: err(new Error(`${name}: ${result.error.message}`));
				}),
			);
			return noted.find((result) => !result.ok) ?? ok(undefined);
		},
	});
}

export namespace Dispatchers {
	export const merge = (dispatchers: Named<Dispatcher>): Dispatcher => ({
		// Unlike activity, asking for triggers is something the human just did, so a failing
		// contributor is reported (by name) instead of quietly offering fewer.
		triggers: async (taskId) => {
			const offered = await Promise.all(
				Object.entries(dispatchers).map(
					async ([name, dispatcher]): Promise<Result<TriggerDescriptor[]>> => {
						const triggers = await dispatcher.triggers(taskId);
						if (!triggers.ok)
							return err(new Error(`${name}: ${triggers.error.message}`));
						return ok(
							triggers.value.map((trigger) => ({
								...trigger,
								id: prefixed(name, trigger.id),
							})),
						);
					},
				),
			);
			const failed = offered.find((result) => !result.ok);
			if (failed && !failed.ok) return failed;
			return ok(offered.flatMap((result) => (result.ok ? result.value : [])));
		},
		dispatch: async (triggerId, target, inputs) => {
			const routed = route(dispatchers, triggerId);
			if (!routed) return err(unrouted("trigger", triggerId));
			return routed.part.dispatch(routed.id, target, inputs);
		},
	});
}

export namespace Headers {
	/**
	 * Each contributor's headers, by card kind, as one map. A header gets its card with the id its
	 * contributor minted, as `card()` and `events()` do, so it can look its own state up. A kind two
	 * contributors both name goes to the later one.
	 */
	export const merge = (
		headers: Named<Readonly<Record<string, CardHeader>>>,
	): Record<string, CardHeader> => {
		const merged: Record<string, CardHeader> = {};
		for (const [name, byKind] of Object.entries(headers)) {
			const prefix = prefixed(name, "");
			for (const [kind, Header] of Object.entries(byKind))
				merged[kind] = (props) =>
					createElement(Header, {
						...props,
						card: {
							...props.card,
							id: props.card.id.startsWith(prefix)
								? props.card.id.slice(prefix.length)
								: props.card.id,
						},
					});
		}
		return merged;
	};
}
