import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Vitest 4 shape: the pool is a Vite plugin now, not `poolOptions.workers`
 * (`@cloudflare/vitest-pool-workers` >= 0.18 dropped the `/config` entrypoint;
 * every tutorial still shows `defineWorkersConfig`).
 */
export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
