import { expect, test } from "bun:test";
import { runUpdateProcess } from "./update-process";

const run = (source: string, ms = 1000, bytes = 1000) =>
	runUpdateProcess(
		[process.execPath, "-e", source],
		process.cwd(),
		process.env,
		ms,
		bytes,
	);
test("bounded process captures only stdout and never forwards credential-bearing diagnostics", async () => {
	const result = await run(
		'console.log("ok"); console.error("https://user:secret@registry.invalid _authToken=secret"); process.exit(7)',
	);
	expect(result).toEqual({ ok: true, value: { code: 7, stdout: "ok\n" } });
});
test("bounded process stops excess stdout and stderr", async () => {
	for (const stream of ["stdout", "stderr"]) {
		const result = await run(
			`process.${stream}.write("x".repeat(10000)); await Bun.sleep(10000)`,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).not.toContain("xxxx");
	}
});
test("bounded process timeout cancels a child process group and its pipes", async () => {
	const start = Date.now();
	const result = await run(
		'Bun.spawn([process.execPath,"-e","await Bun.sleep(10000)"],{stdout:"inherit",stderr:"inherit"}); await Bun.sleep(10000)',
		100,
	);
	expect(result.ok).toBe(false);
	expect(Date.now() - start).toBeLessThan(2000);
});
