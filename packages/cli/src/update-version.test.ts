import { expect, test } from "bun:test";
import {
	ChannelVersionSchema,
	channelOf,
	compareVersions,
	SemverSchema,
} from "./update-version";

test("prerelease precedence follows SemVer, numeric fields compared as numbers", () => {
	expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
	expect(compareVersions("1.0.0", "1.0.0-beta.9")).toBeGreaterThan(0);
	expect(compareVersions("1.0.0-beta.0", "0.3.0")).toBeGreaterThan(0);
	expect(compareVersions("1.0.0-beta.0", "1.0.0-beta.0")).toBe(0);
	expect(compareVersions("1.0.0-beta", "1.0.0-beta.0")).toBeLessThan(0);
	expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.a")).toBeLessThan(0);
	expect(compareVersions("1.0.0-alpha.9", "1.0.0-beta.0")).toBeLessThan(0);
	expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
	expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
});

test("a channel version is stable or beta.N; any other prerelease is only SemVer", () => {
	for (const version of ["0.3.0", "1.0.0-beta.0", "1.0.0-beta.12"])
		expect(ChannelVersionSchema.safeParse(version).success).toBe(true);
	for (const version of [
		"1.0.0-beta",
		"1.0.0-beta.01",
		"1.0.0-rc.1",
		"1.0.0-beta.1.2",
		"01.0.0",
		"1.0.0+build",
		"1.0.0-beta.9007199254740992",
	])
		expect(ChannelVersionSchema.safeParse(version).success).toBe(false);
	expect(SemverSchema.safeParse("1.0.0-rc.1").success).toBe(true);
	expect(SemverSchema.safeParse("1.0.0-next.1.x-y").success).toBe(true);
	for (const version of ["invalid-version", "1.0.0-", "1.0.0-01", "1.0"])
		expect(SemverSchema.safeParse(version).success).toBe(false);
	expect(channelOf("1.0.0-beta.0")).toBe("beta");
	expect(channelOf("1.0.0")).toBe("latest");
});
