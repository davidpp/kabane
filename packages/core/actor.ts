/**
 * Actor URIs: who wrote a row. A person is `kabane://actor/human/<name>`, an agent runtime
 * `kabane://actor/agent/<name>`. Every identity column stores one (`updated_by`, a comment's
 * author, ...), so the scheme changes only with a migration (`storage/actor-scheme.ts`).
 */
export namespace ActorUri {
	export const PREFIX = "kabane://actor/";
	export const AGENT = `${PREFIX}agent/`;
	export const HUMAN = `${PREFIX}human/`;

	export const agent = (name: string): string => `${AGENT}${name}`;
	export const human = (name: string): string => `${HUMAN}${name}`;
}
