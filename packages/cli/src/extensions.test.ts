import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { configPath } from "./config";
import { Extensions } from "./extensions";

const homes: string[] = [];
const makeHome = (config?: Record<string, unknown>): string => {
	const home = join(tmpdir(), `kabane-extensions-${crypto.randomUUID()}`);
	homes.push(home);
	mkdirSync(home, { recursive: true });
	if (config)
		writeFileSync(
			configPath(home),
			JSON.stringify({
				actor: "cabane://actor/human/t",
				deviceId: "t",
				...config,
			}),
		);
	return home;
};

afterAll(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("Extensions.enableHint", () => {
	it("names the config file to edit when there is one", () => {
		const home = makeHome({});
		const hint = Extensions.enableHint("loop", "loop", home);
		expect(hint).toContain(`add "loop" to "extensions" in ${configPath(home)}`);
		expect(hint).not.toContain("kabane init");
	});

	it("sends a device with no config to kabane init first", () => {
		const hint = Extensions.enableHint("loop", "loop", makeHome());
		expect(hint).toContain("run `kabane init`, then add");
	});
});

describe("Extensions.enabled", () => {
	it("keeps the names it ships and warns once about any other", () => {
		const home = makeHome({ extensions: ["loop", "lop"] });
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		try {
			const first = Extensions.enabled(home);
			const again = Extensions.enabled(home);
			expect(first.ok && first.value).toEqual(["loop"]);
			expect(again.ok && again.value).toEqual(["loop"]);
			expect(stderr).toHaveBeenCalledTimes(1);
			expect(String(stderr.mock.calls[0]?.[0])).toContain('ignoring "lop"');
		} finally {
			stderr.mockRestore();
		}
	});
});

describe("Extensions.namespaces", () => {
	it("is every shipped extension's settings, enabled or not", async () => {
		const found = await Extensions.namespaces();
		expect(found.ok && found.value.map((n) => n.name)).toEqual(["loop"]);
	});

	it("refuses a namespace that would take a device key or the scopes block", () => {
		const settings = z.object({}).strict();
		for (const name of ["sync", "db", "actor", "deviceId", "scopes"]) {
			const refused = Extensions.namespacesOf([{ name, settings }]);
			expect(!refused.ok && refused.error.message).toContain(
				`would take the device config key "${name}"`,
			);
		}
	});

	it("refuses a schema an empty layer does not satisfy", () => {
		const refused = Extensions.namespacesOf([
			{ name: "strict", settings: z.object({ needed: z.string() }) },
		]);
		expect(!refused.ok && refused.error.message).toContain(
			"need a default or optional for every key",
		);
	});
});
