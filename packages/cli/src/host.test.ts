import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@kabane/core";
import { parseArgs } from "@kabane/extension";
import { defaultDeviceId } from "./config";
import { openContext } from "./context";
import { activateHostRecord, createHost } from "./host";
import * as scope from "./scope/detect";

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
			actor: "kabane://actor/human/test",
			deviceId: "test",
			harness: { mode: "default" },
		}),
	);
	const { host, build } = createHost(home);
	await build(() => undefined);
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
		parseArgs(["--as", "kabane://actor/agent/test", "--scope", "host-test"]),
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
	const later = createHost(home);
	await later.build(() => undefined);
	const comment = await later.host.record.comment({
		id: task.id,
		body: "After opening",
	});
	expect(comment).toMatchObject({
		ok: true,
		value: { author: "kabane://actor/agent/test" },
	});
	expect(await Planner.getEntries(home, task.id)).toMatchObject({
		ok: true,
		value: [{ content: "After opening" }],
	});
	expect((await createHost(`${home}/other`).host.record.list({})).ok).toBe(
		false,
	);
	expect((await openContext(`${home}/missing`, home, parseArgs([]))).ok).toBe(
		false,
	);
	expect((await host.record.list({})).ok).toBe(false);
});

const configuredHome = () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-host-"));
	homes.push(home);
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({ actor: "kabane://actor/human/test", deviceId: "test" }),
	);
	return home;
};

it("opens without scope detection, then resolves it only once across record calls and hosts", async () => {
	const home = configuredHome();
	const detect = spyOn(scope, "detectScope");
	try {
		const ctx = await openContext(home, home, parseArgs([]));
		if (!ctx.ok) throw ctx.error;
		expect(detect).not.toHaveBeenCalled();
		const first = createHost(home);
		await first.build(() => undefined);
		expect((await first.host.record.list({})).ok).toBe(true);
		const second = createHost(home);
		await second.build(() => undefined);
		expect((await second.host.record.list({})).ok).toBe(true);
		expect(detect).toHaveBeenCalledTimes(1);
	} finally {
		detect.mockRestore();
	}
});

it("caches harness mode and device id on first use and shares them with the command", async () => {
	const home = configuredHome();
	const { host } = createHost(home);
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			actor: "kabane://actor/human/test",
			deviceId: "studio",
			harness: { mode: "default" },
		}),
	);
	expect(host.harnessMode).toBe("default");
	expect(host.device).toBe("studio");
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			actor: "kabane://actor/human/test",
			deviceId: "test",
			harness: { mode: "auto" },
		}),
	);
	expect(host.harnessMode).toBe("default");
	expect(host.device).toBe("studio");
	const ctx = await openContext(home, home, parseArgs([]));
	if (!ctx.ok) throw ctx.error;
	expect(ctx.value.harnessMode).toBe(host.harnessMode);
	expect(ctx.value.device).toBe("studio");
	expect(createHost(home).host.harnessMode).toBe("default");
});

it("gives a home with no config the device id init would save", () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-host-"));
	homes.push(home);
	expect(createHost(home).host.device).toBe(defaultDeviceId());
});

it("passes question cursors untouched through record.call", async () => {
	const home = configuredHome();
	const ctx = await openContext(home, home, parseArgs([]));
	if (!ctx.ok) throw ctx.error;
	const { host, build } = createHost(home);
	await build(() => undefined);
	const added = await Planner.addTask(home, { title: "Paged", kind: "issue" });
	if (!added.ok) throw added.error;
	const id = added.value.id;
	const asked = await host.record.call("kabane_ask", {
		id,
		questions: [{ question: "First?" }, { question: "Second?" }],
	});
	if (!asked.ok) throw asked.error;
	const first = await host.record.call("kabane_questions", { id, limit: 1 });
	if (!first.ok || typeof first.value !== "string")
		throw new Error("Expected question page");
	const cursor = first.value.split("nextCursor: ")[1];
	expect(cursor).toBeDefined();
	const second = await host.record.call("kabane_questions", {
		id,
		limit: 1,
		cursor,
	});
	if (!second.ok || typeof second.value !== "string")
		throw new Error("Expected second question page");
	expect(second.value).toContain("Second?");
	expect(second.value).not.toContain("First?");
	const invalid = await host.record.call("kabane_questions", {
		id,
		limit: 1,
		cursor: "garbage",
	});
	expect(invalid.ok).toBe(false);
	if (invalid.ok) throw new Error("Expected invalid cursor");
	expect(invalid.error.message).toContain("Invalid questions cursor");
});
