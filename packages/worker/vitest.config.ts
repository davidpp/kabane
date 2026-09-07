import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Vitest 4 shape: the pool is a Vite plugin now, not `poolOptions.workers`
 * (`@cloudflare/vitest-pool-workers` >= 0.18 dropped the `/config` entrypoint;
 * every tutorial still shows `defineWorkersConfig`).
 *
 * The bearer secret is a real secret in production (`wrangler secret put`), so
 * it cannot live in `wrangler.jsonc`. Tests bind their own value here instead.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: { SYNC_TOKEN: "test-token-do-not-deploy" },
			},
		}),
	],
});
