// The first-run setup screen's logic, without a renderer: which rows the form has, how focus and
// the checkboxes move, and what the answers become — an actor URI, a device id and the harnesses to
// wire. The device id is the short hostname, never asked: it only names the machine once sync is
// set up (docs/deploy.md), and it can be renamed in the config until the first push. setup.tsx is a thin layer over this; the host turns a Plan into its own
// config (the board cannot see the CLI's schema) and runs the installs.
import { err, ok, type Result } from "@cabane/core";

export namespace SetupPlan {
	/** A harness the host found on this machine, by the id its installer takes. */
	export type Harness = { id: string; label: string };

	export type Defaults = {
		/** Prefilled name: the OS username. */
		name: string;
		/** The device id setup saves: the short hostname. */
		device: string;
		/** Detected harnesses, checked by default. Empty shows where the snippets are instead. */
		harnesses: readonly Harness[];
		/** Where confirming writes the config, as the screen says it before enter. */
		configPath: string;
	};

	export type Field = { kind: "name" } | { kind: "harness"; harness: Harness };

	export type Form = {
		name: string;
		checked: readonly string[];
		focus: number;
	};

	export type Plan = {
		actor: string;
		deviceId: string;
		install: readonly string[];
	};

	export type InstallStatus = "installed" | "already" | "failed";

	/** One harness's install, as the host reports it. `message` is the harness's own words. */
	export type InstallOutcome = {
		id: string;
		status: InstallStatus;
		message?: string;
	};

	export const ACTOR_PREFIX = "cabane://actor/human/";

	export const fields = (defaults: Defaults): Field[] => [
		{ kind: "name" },
		...defaults.harnesses.map(
			(harness): Field => ({ kind: "harness", harness }),
		),
	];

	// Every detected harness starts checked: wiring the agents is why most people run setup at all.
	export const initialForm = (defaults: Defaults): Form => ({
		name: defaults.name,
		checked: defaults.harnesses.map((h) => h.id),
		focus: 0,
	});

	/** Focus wraps, so tab from the last row lands back on the name. */
	export const moveFocus = (
		form: Form,
		defaults: Defaults,
		delta: number,
	): Form => {
		const count = fields(defaults).length;
		return { ...form, focus: (((form.focus + delta) % count) + count) % count };
	};

	export const focused = (form: Form, defaults: Defaults): Field | undefined =>
		fields(defaults)[form.focus];

	/** Space on a checkbox row flips it; on a text row it does nothing. */
	export const toggle = (form: Form, defaults: Defaults): Form => {
		const field = focused(form, defaults);
		if (field?.kind !== "harness") return form;
		const id = field.harness.id;
		return {
			...form,
			checked: form.checked.includes(id)
				? form.checked.filter((c) => c !== id)
				: [...form.checked, id],
		};
	};

	/**
	 * The name as an actor URI's last segment: `David Paquet` → `david-paquet`. The URI format is
	 * what the old `cabane init --actor` asked a newcomer to type; here they type a name.
	 */
	export const actorSlug = (name: string): string =>
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "");

	export const actorUri = (name: string): string =>
		`${ACTOR_PREFIX}${actorSlug(name)}`;

	export const plan = (form: Form, defaults: Defaults): Result<Plan> => {
		const slug = actorSlug(form.name);
		if (slug === "") return err(new Error("name needs a letter or a digit"));
		return ok({
			actor: `${ACTOR_PREFIX}${slug}`,
			deviceId: defaults.device,
			// In detection order, whatever order the boxes were ticked in.
			install: defaults.harnesses
				.map((h) => h.id)
				.filter((id) => form.checked.includes(id)),
		});
	};
}
