import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Vitest 4 shape: the pool is a Vite plugin now, not `poolOptions.workers`
 * (`@cloudflare/vitest-pool-workers` >= 0.18 dropped the `/config` entrypoint;
 * every tutorial still shows `defineWorkersConfig`).
 *
 * The bearer secret is a real secret in production (`wrangler secret put`), so
 * it cannot live in `wrangler.jsonc`. Tests bind their own value here instead.
 *
 * `ACCESS_DEV_UNVERIFIED` lets the suite hand the edge unsigned assertions
 * whose payload it controls, so the Access → principal → actor mapping is
 * exercised without a Cloudflare tenant. The identities below are the
 * fixtures `src/test-access.ts` builds tokens for.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					SYNC_TOKEN: "test-token-do-not-deploy",
					ACCESS_DEV_UNVERIFIED: "true",
					HUMAN_EMAIL: "david@example.com",
					SERVICE_ACTORS: JSON.stringify({
						"hermes-client-id.access": "cabane://actor/agent/hermes",
						"claude-client-id.access": "cabane://actor/agent/claude",
					}),
					SYNC_INTERVAL_MINUTES: "5",
				},
			},
		}),
	],
});
