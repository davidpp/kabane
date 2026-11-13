import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, trySync, type Result } from "../../packages/core/result";
import { readJson } from "./files";
import { command } from "./process";
import type { Harness } from "./schema";

const codexAuth = z
	.object({
		auth_mode: z.literal("chatgpt"),
		tokens: z.object({ access_token: z.string().min(1) }).passthrough(),
		last_refresh: z.string().optional(),
	})
	.passthrough();
const claudeAuth = z
	.object({
		claudeAiOauth: z
			.object({
				accessToken: z.string().min(1),
				subscriptionType: z.string().min(1),
				scopes: z.array(z.string()).optional(),
			})
			.passthrough(),
	})
	.passthrough();
const subscriptionTypes = new Set([
	"pro",
	"max",
	"team",
	"enterprise",
	"ultra",
]);
export const prepareAuth = async (
	harness: Harness,
	home: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<() => void>> => {
	if (harness === "codex") {
		const source = join(
			process.env.CODEX_HOME ?? join(homedir(), ".codex"),
			"auth.json",
		);
		const checked = readJson(source, codexAuth);
		if (!checked.ok)
			return err(
				new Error(
					"Codex requires a ChatGPT login in auth.json; run codex login using your subscription.",
				),
			);
		const payload = trySync((): unknown =>
			JSON.parse(
				Buffer.from(
					checked.value.tokens.access_token.split(".")[1] ?? "",
					"base64url",
				).toString(),
			),
		);
		const expiry = payload.ok
			? z.object({ exp: z.number() }).safeParse(payload.value)
			: null;
		if (!expiry?.success || expiry.data.exp * 1000 < Date.now() + 8_000_000)
			return err(
				new Error(
					"Codex subscription access token is missing/near expiry. Refresh your normal Codex login, then retry. The runner never copies refresh tokens.",
				),
			);
		const target = join(home, ".codex", "auth.json");
		const copied = trySync(() => {
			mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
			// Only subscription credentials travel; a stored API key is never forwarded.
			writeFileSync(
				target,
				JSON.stringify({
					auth_mode: "chatgpt",
					tokens: { ...checked.value.tokens, refresh_token: "" },
					last_refresh: checked.value.last_refresh,
				}),
				{ mode: 0o600 },
			);
		});
		return copied.ok ? ok(() => rmSync(target, { force: true })) : copied;
	}
	const file = join(
		process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
		".credentials.json",
	);
	const raw = existsSync(file)
		? trySync(() => readFileSync(file, "utf8"))
		: await command(
				[
					"security",
					"find-generic-password",
					"-s",
					"Claude Code-credentials",
					"-w",
				],
				home,
			);
	if (!raw.ok)
		return err(
			new Error(
				"Claude subscription credentials unavailable. Log in with claude auth login; macOS needs keychain access.",
			),
		);
	const decoded = trySync((): unknown => JSON.parse(raw.value));
	if (!decoded.ok)
		return err(new Error("Claude credentials have an unsupported format."));
	const checked = claudeAuth.safeParse(decoded.value);
	if (
		!checked.success ||
		!subscriptionTypes.has(checked.data.claudeAiOauth.subscriptionType)
	)
		return err(
			new Error(
				"Claude credentials do not identify a supported subscription; API billing is refused.",
			),
		);
	env.CLAUDE_CODE_OAUTH_TOKEN = checked.data.claudeAiOauth.accessToken;
	return ok(() => {
		delete env.CLAUDE_CODE_OAUTH_TOKEN;
	});
};
