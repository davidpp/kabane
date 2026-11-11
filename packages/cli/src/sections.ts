import { CONTEXT_SECTIONS, type KabaneModule } from "@cabane/core";

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

/**
 * Every section of the brief `modules` make, in order: core's, each module's after the
 * one it names, modules in registration order. The order core's own list of valid
 * sections has, so a usage line built from it matches the error that lists them.
 */
export const briefSections = (modules: readonly KabaneModule[]): string[] => {
	const added = modules.flatMap(sectionsOf);
	return CONTEXT_SECTIONS.flatMap((core) => [
		core,
		...added
			.filter((section) => section.after === core)
			.map((section) => section.name),
	]);
};
