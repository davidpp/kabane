import { describe, expect, it } from "bun:test";
import { version } from "../package.json";
import { run } from "./main";

describe("run", () => {
	it("prints the package version for --version and -v", async () => {
		for (const flag of ["--version", "-v"]) {
			const outcome = await run([flag], {}, "/");
			expect(outcome).toEqual({
				exitCode: 0,
				json: { version },
				text: version,
			});
		}
	});
});
