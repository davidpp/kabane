import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
