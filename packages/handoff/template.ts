/** The entry kind a handoff is written as. */
export const HANDOFF_KIND = "handoff";

/**
 * The handoff's headings, each with the one line saying what belongs under it.
 * Nothing checks a body against them: the headings do the work, because no one
 * can write under Evidence without having looked.
 */
const HEADINGS = [
	["Summary", "The smallest picture of what was made or changed."],
	[
		"Evidence",
		"What you saw, not what you concluded: an output, a quoted source, a measurement, a ref to a screenshot or a file. Before and after, when there is a before.",
	],
	[
		"Not verified",
		"What you did not or could not check, a check only a human can make included.",
	],
	[
		"Risk",
		"Whether acting on this can be walked back, and who or what is affected if it is wrong.",
	],
] as const;

/**
 * The default body of a handoff. Its headings sit one level under the brief's
 * `## Handoff from …` heading, so the body nests inside its section.
 */
export const HANDOFF_TEMPLATE = HEADINGS.map(
	([heading, line]) => `### ${heading}\n\n${line}`,
).join("\n\n");

/** The template on one line per heading, for a tool description. */
export const COMPACT_TEMPLATE = HEADINGS.map(
	([heading, line]) => `### ${heading}: ${line}`,
).join("\n");
