import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../../packages/core/result";
import { isNewDirectory, write, writeJson } from "./files";
import type { Recipe } from "./schema";

const browserCommand = (): string => {
	const pinned = join(
		homedir(),
		".local/share/mise/installs/aqua-vercel-labs-agent-browser/0.42.0/agent-browser",
	);
	return existsSync(pinned) ? pinned : (Bun.which("agent-browser") ?? pinned);
};
const common = `Build and maintain the requested small local app in this workspace. Use Bun and TypeScript. Make reasonable decisions without asking questions; record assumptions. Keep implementation scoped. Verify the real running application, not a fabricated backend or mocked integration. Do not deploy, use paid services, invoke other model services, or delegate to additional agents. Stay within this workspace and the explicitly provided work-record tools. Do not read other experiments, user dotfiles, transcripts, or account credentials.\n\nYou may use native planning, git, and repository notes. Before finishing, leave a durable handoff with completed work, decisions, known gaps, and exact verification evidence so a fresh agent can continue. Do not claim unobserved success. Provide the local launch command and URL in your final response.\n`;
const build = `Build a local equipment reservation web app. Equipment has a name and description. Users can create/edit equipment, search it, and reserve an item with borrower name and start/end timestamps. Reject invalid date ranges and overlapping active reservations for the same item; adjacent reservations are allowed. Users can cancel reservations. Persist records across restarts. Show useful validation errors and empty states. Support desktop and mobile widths. No login, external accounts, paid APIs or deployment.\n\nUse whichever small local implementation fits. Include a working package.json with dev, build/check and test commands. Verify creation, conflict rejection, adjacency, cancellation, and persistence through the running UI.\n`;
const change = `Continue the existing application. First inspect its durable handoff and repository, and explain what works, what remains unverified, and the relevant design decisions with references.\n\nAdd maintenance periods during which equipment cannot be reserved. Reject a maintenance period overlapping an active reservation. Add rescheduling; an invalid reschedule must preserve the original reservation. Preserve all existing equipment and reservations. Verify the new behavior and original flows through the running application.\n`;
const smokeCommon = `This is an infrastructure smoke test, not an app benchmark. Work only in this workspace and the provided work-record tools. Use no external services, subagents or model calls. Follow the requested file operations exactly. Preserve a durable handoff with one decision and evidence using the available work-record mechanism.\n`;
const smokeBuild = `Create app.ts exporting add(a: number, b: number): number that adds its inputs. Create package.json with a check script that runs bun app.ts. Execute bun app.ts. Write DECISION.md saying: "The app uses addition, not multiplication." Create browser.html containing a button named Check that changes the page text to 42 when clicked. Use the configured real browser CLI to open that local file, snapshot, click Check, read the changed text, and save browser-round-1.png. Record the observed browser result in BROWSER-VERIFIED.md. Leave your handoff.\n`;
const smokeChange = `Read the existing handoff and DECISION.md. Preserve the add function. Add export const label = "continued" to app.ts. Run bun -e 'import {add,label} from "./app.ts"; if(add(2,3)!==5 || label!=="continued") process.exit(1)'. Create CONTINUED.md explaining the preserved decision and verification result. Use the configured real browser CLI to open browser.html, click Check and verify 42 in the page, then save browser-round-2.png. Append your browser evidence to BROWSER-VERIFIED.md. Leave your handoff.\n`;
export const initialize = (directory: string, smoke: boolean): Result<void> => {
	const available = isNewDirectory(directory);
	if (!available.ok) return available;
	const recipe: Recipe = {
		version: 1,
		name: smoke ? "handoff-smoke" : "equipment-reservations",
		models: { codex: "gpt-6-astra", claude: "claude-opus-5-5" },
		effort: "medium",
		maxSeconds: smoke ? 180 : 1800,
		maxAttempts: 2,
		billingControlsVerified: false,
		common: "common.md",
		rubric: "rubric.md",
		starter: "starter",
		rounds: [
			{ prompt: "round-1.md", harness: "codex" },
			{ prompt: "round-2.md", harness: "claude" },
		],
	};
	const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	recipe.browser = {
		command: browserCommand(),
		...(existsSync(chrome) ? { executable: chrome } : {}),
	};
	if (smoke) recipe.evaluator = "evaluate.ts";
	const files: Record<string, string> = {
		"common.md": smoke ? smokeCommon : common,
		"rubric.md": smoke
			? "Round 1: app.ts exports working addition; DECISION.md exists. Round 2: addition preserved, continued label exported, CONTINUED.md cites the preserved decision. Treatment: real Kabane records written and read across rounds. This proves runner plumbing, not app quality.\n"
			: "Round 1: app launches; equipment create/edit/search; valid booking; rejects overlap/invalid range; permits adjacency; cancellation frees time; survives restart; usable desktop/mobile UI. Round 2: all round 1 checks still pass; maintenance blocks booking; conflicts with existing reservation rejected; valid reschedule succeeds; invalid reschedule leaves original intact; existing records survive. Record browser evidence and individual failed checks. Process completion is not a passing grade.\n",
		"round-1.md": smoke ? smokeBuild : build,
		"round-2.md": smoke ? smokeChange : change,
		"starter/README.md":
			"# Local benchmark application\n\nImplement the supplied requirements here.\n",
		"README.md":
			"Edit common.md and round-*.md before freezing. recipe.json sets harness order, exact models and wall-time caps. Use subscription logins and disable automatic paid fallback in account settings. The runner does not control account-level credit settings. Freeze creates a new immutable experiment; never edit its frozen inputs. See wiki/benchmark.md in Kabane for commands and evaluation.\n",
	};
	for (const [name, content] of Object.entries(files)) {
		const result = write(join(directory, name), content);
		if (!result.ok) return result;
	}
	if (smoke) {
		const evaluator = write(
			join(directory, "evaluate.ts"),
			`import {existsSync} from "node:fs";\nconst app = await import(process.cwd() + "/app.ts");\nif (app.add(2,3) !== 5 || !existsSync("DECISION.md")) process.exit(1);\nif (process.env.BENCHMARK_ROUND === "2" && (app.label !== "continued" || !existsSync("CONTINUED.md"))) process.exit(1);\nif (!existsSync("BROWSER-VERIFIED.md") || !existsSync("browser-round-" + process.env.BENCHMARK_ROUND + ".png")) process.exit(1);\nconsole.log("Real exports, durable decision and browser artifacts verified; inspect browser trace for interaction correctness");\n`,
		);
		if (!evaluator.ok) return evaluator;
	}
	const saved = writeJson(join(directory, "recipe.json"), recipe);
	return saved.ok ? ok(undefined) : err(saved.error);
};
