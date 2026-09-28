#!/usr/bin/env bun
/**
 * Operator-only hub deploy. Supply credentials from your own environment; never put them in
 * wrangler.jsonc or on the command line. --dry-run checks the bundle without uploading anything.
 */
import { join, resolve } from "node:path";

const WORKER = resolve(import.meta.dir, "../packages/worker");
const REQUIRED = [
	"CLOUDFLARE_API_TOKEN",
	"CLOUDFLARE_ACCOUNT_ID",
	"SYNC_TOKEN",
	"HUB_DOMAIN",
	"ACCESS_TEAM_DOMAIN",
] as const;
const VARS = [
	"ACCESS_TEAM_DOMAIN",
	"ACCESS_AUD",
	"HUMAN_EMAIL",
	"SERVICE_ACTORS",
	"KABANE_TIMEZONE",
] as const;

const fail = (message: string): never => {
	console.error(`deploy: ${message}`);
	process.exit(1);
};

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run"))
	fail("usage: bun run deploy [--dry-run]");

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) fail(`missing ${missing.join(", ")}`);

const domain = process.env.HUB_DOMAIN;
const token = process.env.SYNC_TOKEN;
if (!domain || !token) fail("missing HUB_DOMAIN or SYNC_TOKEN");

const wrangler = join(WORKER, "node_modules/.bin/wrangler");
const deploy = Bun.spawnSync(
	[
		wrangler,
		"deploy",
		"--domain",
		domain,
		...VARS.flatMap((name) => ["--var", `${name}:${process.env[name] ?? ""}`]),
		...(args[0] === "--dry-run" ? ["--dry-run"] : []),
	],
	{ cwd: WORKER, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
);
if (deploy.exitCode !== 0) fail(`wrangler deploy exited ${deploy.exitCode}`);
if (args[0] === "--dry-run") process.exit(0);

// A deploy from the tracked config does not upload SYNC_TOKEN. Only update it after the
// Worker and all its vars have deployed; on a fresh hub the Worker refuses sync until then.
const secret = Bun.spawn([wrangler, "secret", "put", "SYNC_TOKEN"], {
	cwd: WORKER,
	stdin: "pipe",
	stdout: "inherit",
	stderr: "inherit",
});
secret.stdin.write(`${token}\n`);
await secret.stdin.end();
const code = await secret.exited;
if (code !== 0) fail(`wrangler secret put SYNC_TOKEN exited ${code}`);
