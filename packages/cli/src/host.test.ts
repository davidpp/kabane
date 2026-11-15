import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@cabane/core";
import { parseArgs } from "@cabane/extension";
import { openContext } from "./context";
import { activateHostRecord, createHost } from "./host";

const homes: string[] = [];
afterEach(() => {
	activateHostRecord("");
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

it("activates existing and later hosts with the command's actor, scope and module tools", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-host-"));
	homes.push(home);
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			actor: "cabane://actor/human/test",
			deviceId: "test",
			harness: { mode: "default" },
		}),
	);
	const host = createHost(home);
	expect(host.api).toBe(1);
	expect(host.harnessMode).toBe("default");
	expect((await host.record.list({})).ok).toBe(false);
	expect(host.scope.idOf("jake://scope/test")).toEqual(host.result.ok("test"));
	expect(host.scope.idOf("kabane://scope/%ZZ").ok).toBe(false);
	expect(
		host.settings.fields(
			host.z.object({ word: host.z.string().default("hello") }),
		),
	).toMatchObject([{ path: ["word"], default: "hello" }]);
	expect(host.args.flagBool(parseArgs(["--yes"]), "yes")).toBe(true);
	const ctx = await openContext(
		home,
		home,
		parseArgs(["--as", "cabane://actor/agent/test", "--scope", "host-test"]),
	);
	if (!ctx.ok) throw ctx.error;
	const added = await host.record.call("kabane_add", {
		title: "Host task",
		kind: "issue",
	});
	if (!added.ok) throw added.error;
	const tasks = await host.record.list({});
	if (!tasks.ok) throw tasks.error;
	const task = tasks.value[0];
	if (!task) throw new Error("Missing task");
	expect(task.scopeUri).toBe("kabane://scope/host-test");
	expect(await host.record.call("kabane_checklist", { id: task.id })).toEqual(
		host.result.ok([]),
	);
	const comment = await createHost(home).record.comment({
		id: task.id,
		body: "After opening",
	});
	expect(comment).toMatchObject({
		ok: true,
		value: { author: "cabane://actor/agent/test" },
	});
	expect(await Planner.getEntries(home, task.id)).toMatchObject({
		ok: true,
		value: [{ content: "After opening" }],
	});
	expect((await createHost(`${home}/other`).record.list({})).ok).toBe(false);
	expect((await openContext(`${home}/missing`, home, parseArgs([]))).ok).toBe(
		false,
	);
	expect((await host.record.list({})).ok).toBe(false);
});
