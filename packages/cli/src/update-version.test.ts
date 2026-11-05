import { expect, test } from "bun:test";
import {
	ChannelVersionSchema,
	channelOf,
	compareVersions,
	followedTag,
	onChannel,
	SemverSchema,
	withinVersionPolicy,
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

test("a stable install follows latest; a beta install the higher of beta and latest", () => {
	const tags = { latest: "1.0.0", beta: "1.1.0-beta.2" };
	expect(followedTag("1.0.0", tags)).toBe("latest");
	expect(followedTag("1.0.0-beta.0", tags)).toBe("beta");
	expect(
		followedTag("1.0.0-beta.0", { latest: "1.0.0", beta: "1.0.0-beta.3" }),
	).toBe("latest");
	expect(followedTag("1.0.0-beta.0", { latest: "0.3.0" })).toBe("latest");
});

test("a stable install takes stable releases only; a beta install also takes beta.N", () => {
	expect(onChannel("1.1.0", "1.0.0")).toBe(true);
	expect(onChannel("1.1.0-beta.0", "1.0.0")).toBe(false);
	expect(onChannel("1.1.0-beta.0", "1.0.0-beta.0")).toBe(true);
	expect(onChannel("1.1.0-rc.1", "1.0.0-beta.0")).toBe(false);
});

test("the version policy stays within the major, and the minor below 1.0, and never goes down", () => {
	expect(withinVersionPolicy("1.4.0", "1.0.0")).toBe(true);
	expect(withinVersionPolicy("2.0.0", "1.9.0")).toBe(false);
	expect(withinVersionPolicy("0.3.9", "0.3.0")).toBe(true);
	expect(withinVersionPolicy("0.4.0", "0.3.0")).toBe(false);
	expect(withinVersionPolicy("0.9.0", "1.0.0")).toBe(false);
	expect(withinVersionPolicy("1.0.0", "1.0.0-beta.0")).toBe(true);
});
