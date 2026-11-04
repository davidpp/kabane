import { describe, expect, it } from "bun:test";
import type { Task } from "@cabane/core";
import { Brief } from "./brief";

const task = (id: string, title: string): Task => ({
	id,
	shortId: id,
	title,
	kind: "issue",
	state: "next",
	priority: "normal",
	provenance: { source: "human", discoveredAt: "2026-11-04T00:00:00.000Z" },
	needsReview: false,
	tags: [],
	createdAt: "2026-11-04T00:00:00.000Z",
	updatedAt: "2026-11-04T00:00:00.000Z",
});

const attempt: Brief.Interrupted = {
	lane: "P-2",
	startedAt: "2026-11-04T10:00:00.000Z",
	acpSessionId: "acp-1",
	logged: ["file:hello.txt (wip)"],
	commits: "",
	status: "?? hello.txt",
};

const subject = {
	runId: "r1",
	parent: task("P-1", "parent"),
	task: task("P-2", "child"),
};

describe("Brief, after an interrupted attempt", () => {
	it("tells a new session what the attempt left, before the issue's own brief", () => {
		const sections = Brief.opening(
			{ ...subject, interrupted: attempt },
			"ASSEMBLED",
		).split("\n\n---\n\n");
		expect(sections).toHaveLength(3);
		expect(sections[1]).toStartWith(
			"This work was started before, by attempt P-2 (from 2026-11-04T10:00:00.000Z), which was interrupted",
		);
		expect(sections[1]).toContain("- file:hello.txt (wip)");
		expect(sections[1]).toContain("It made no commit.");
		expect(sections[1]).toContain("```\n?? hello.txt\n```");
		expect(sections[2]).toBe("ASSEMBLED");
	});

	it("says nothing of it to a first attempt", () => {
		expect(
			Brief.opening(subject, "ASSEMBLED").split("\n\n---\n\n"),
		).toHaveLength(2);
	});

	it("puts the takeover in a lens's and the fixer's brief too", () => {
		const lens = Brief.lens(
			{
				...subject,
				lens: "security",
				prompt: "LENS",
				gates: [],
				interrupted: attempt,
			},
			"ASSEMBLED",
		);
		const fixer = Brief.fixer(
			{ ...subject, findings: [], gates: [], interrupted: attempt },
			"ASSEMBLED",
		);
		for (const brief of [lens, fixer])
			expect(brief).toContain(
				"by attempt P-2 (from 2026-11-04T10:00:00.000Z), which was interrupted",
			);
	});

	it("tells the resumed session only that its last turn was cut, with what the tree shows", () => {
		const prompt = Brief.resumed(attempt);
		expect(prompt).toStartWith(
			"The kabane loop runner exited while your last turn was running",
		);
		expect(prompt).toContain("?? hello.txt");
		expect(prompt).not.toContain("You are one implementing session");
	});
});
