// Each copilot file the board refuses, and a package.json description it does not show, as a
// finding of the extension it belongs to: the board's announcer has room for one line, so this is
// where every refused file is listed by name.
import { join } from "node:path";
import { ok } from "@cabane/core";
import type { Doctor } from "@cabane/extension";
import { CopilotFiles } from "../copilot-files";
import { Extensions } from "../extensions";

// `copilot/shortcuts/x.md` is `copilot-file-shortcuts-x`. A path the kebab form loses characters
// of also carries a hash of the path, so two files never share an id.
const idOf = (file: string): string => {
	const rest = file.replace(/^copilot\//, "").replace(/\.md$/, "");
	const kebab = rest
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const exact = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(rest);
	return `copilot-file-${kebab}${exact ? "" : `-${Bun.hash(file).toString(16).slice(0, 8)}`}`;
};

/** One source per directory extension, named like it, so the runner files each finding under it. */
export const copilotFiles = (
	directories: readonly Extensions.Directory[],
	home: string,
): Doctor.Source[] => {
	const { refused } = CopilotFiles.read(directories);
	return directories.map(({ name, directory }) => ({
		name,
		doctor: async () => {
			const files = refused
				.filter((refusal) => refusal.name === name)
				.map((refusal): Doctor.Finding => ({
					id: idOf(refusal.file),
					severity: "mention",
					path: join(directory, refusal.file),
					summary: Extensions.line(refusal),
				}));
			const description = CopilotFiles.description(
				await Extensions.description(home, name),
			);
			if (description.ok) return ok(files);
			return ok([
				...files,
				{
					id: "package-description",
					severity: "mention",
					path: join(directory, "package.json"),
					summary: Extensions.line({ name, reason: description.error.message }),
				},
			]);
		},
	}));
};
