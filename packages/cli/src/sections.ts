import type { KabaneModule } from "@cabane/core";

/** One section a module adds to the brief, and the core section it follows. */
type ModuleSection = { name: string; after: string };

/** The entry kinds `module` lifts out of the Discussion into a `<kind>.latest` section. */
export const liftedKinds = (module: KabaneModule): string[] =>
	(module.kinds ?? []).flatMap((kind) =>
		kind.projection === "discussion" ? [] : [kind.name],
	);

/** `module`'s own sections, then its lifted kinds', as core orders them. */
export const sectionsOf = (module: KabaneModule): ModuleSection[] => [
	...(module.contextSections ?? []).map(({ name, after }) => ({
		name,
		after,
	})),
	...(module.kinds ?? []).flatMap((kind) =>
		kind.projection === "discussion"
			? []
			: [{ name: `${kind.name}.latest`, after: kind.projection.latest.after }],
	),
];
