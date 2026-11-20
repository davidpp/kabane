import "@kabane/core/testing";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@kabane/core";
import { loop } from "./extension";
import { err, ok, tryCatch, trySync } from "./result";
import { testHost } from "./test-host";

test("the factory binds the host's result helpers before exposing its commands", async () => {
	const home = mkdtempSync(join(tmpdir(), "loop-result-"));
	try {
		const initialized = await Planner.init(home);
		if (!initialized.ok) throw initialized.error;
		const host = testHost(home);
		const extension = loop(host);
		expect(extension.name).toBe("loop");
		expect(ok).toBe(host.result.ok);
		expect(err).toBe(host.result.err);
		expect(tryCatch).toBe(host.result.tryCatch);
		expect(trySync).toBe(host.result.trySync);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
