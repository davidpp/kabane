import { expect, it } from "bun:test";
import { contextSectionsOf } from "./context-output";
import type { KabaneModule } from "./module";
import { ok } from "./result";

const section = (name: string, after: "description" | "discussion") => ({
	name,
	after,
	render: async () => ok(null),
});

it("orders modules sharing an anchor by registration, each module's own sections before its kinds'", () => {
	const first: KabaneModule = {
		name: "first",
		contextSections: [section("first.summary", "description")],
		kinds: [
			{
				name: "first",
				title: "First",
				template: "",
				projection: {
					latest: { after: "description", framing: "The newest first." },
				},
			},
			{
				name: "first.note",
				title: "Note",
				template: "",
				projection: "discussion",
			},
		],
	};
	const second: KabaneModule = {
		name: "second",
		contextSections: [
			section("second.items", "description"),
			section("second.decisions", "discussion"),
		],
	};
	expect(contextSectionsOf([first, second])).toEqual([
		"metadata",
		"description",
		"first.summary",
		"first.latest",
		"second.items",
		"upstream",
		"position",
		"context",
		"priorWork",
		"discussion",
		"second.decisions",
	]);
	expect(contextSectionsOf([second, first]).slice(1, 5)).toEqual([
		"description",
		"second.items",
		"first.summary",
		"first.latest",
	]);
	expect(contextSectionsOf([])).toEqual([
		"metadata",
		"description",
		"upstream",
		"position",
		"context",
		"priorWork",
		"discussion",
	]);
});
