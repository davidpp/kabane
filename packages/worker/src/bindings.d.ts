/**
 * Bindings, mirroring `wrangler.jsonc`.
 *
 * Hand-written rather than `wrangler types`: secrets never appear in the config
 * file, so a generated `Env` would silently omit them once they exist.
 *
 * No top-level `import` here on purpose: that would make this a module and the
 * declaration would stop merging into the ambient `Cloudflare` namespace.
 */
declare namespace Cloudflare {
	interface Env {
		CABANE_LOG: DurableObjectNamespace<import("./log").CabaneLog>;
		CABANE_HUB: DurableObjectNamespace<import("./hub").CabaneHub>;
		/**
		 * Bearer secret for the sync log routes — `wrangler secret put SYNC_TOKEN`.
		 * Optional because an environment where nobody set it is a real state, and
		 * `Auth.authorize` treats it as closed rather than open.
		 */
		SYNC_TOKEN?: string;

		/** Access team, the JWT issuer. `https://3pew.cloudflareaccess.com`. */
		ACCESS_TEAM_DOMAIN: string;
		/** The Access application's AUD tag. Copied from the dashboard after creation. */
		ACCESS_AUD: string;
		/** The one human allowed in. Anyone else with a valid assertion is refused. */
		HUMAN_EMAIL: string;
		/** JSON: service-token client id → actor URI (`cabane://actor/agent/hermes`). */
		SERVICE_ACTORS: string;
		/** Minutes between the hub's scheduled pull/push passes. */
		SYNC_INTERVAL_MINUTES: string;
		/**
		 * `"true"` trusts assertion payloads without checking the signature.
		 * `wrangler dev` and vitest only; never set in `wrangler.jsonc`.
		 */
		ACCESS_DEV_UNVERIFIED?: string;
	}
}
