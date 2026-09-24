// The first-run setup screen's logic, without a renderer: which rows the form has, how focus and
// the checkboxes move, and what the answers become — an actor URI, a device id, the harnesses to
// wire and the agent the first issue goes to. The device id is the short hostname, never asked: it
// only names the machine once sync is set up (docs/deploy.md), and it can be renamed in the config
// until the first push. setup.tsx is a thin layer over this; the host turns a Plan into its own
// config (the board cannot see the CLI's schema), runs the installs and files the first issue.
import { err, ok, type Result } from "@cabane/core";

export namespace SetupPlan {
	/** A harness the host found on this machine, by the id its installer takes. */
	export type Harness = { id: string; label: string };

	export type Defaults = {
		/** Prefilled name: the OS username. */
		name: string;
		/** The device id setup saves: the short hostname. */
		device: string;
		/** Detected harnesses, checked by default. */
		harnesses: readonly Harness[];
		/** No harnesses because the host turned install off, not because none are installed. */
		installOff: boolean;
		/** Where confirming writes the config, as the screen says it before enter. */
		configPath: string;
		/** The project the working directory is in: where the first issue is filed. Absent outside one. */
		project?: string;
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

	/** The issue setup filed for an agent, as the host reports it. */
	export type FirstIssue = { shortId: string; title: string };

	export const ACTOR_PREFIX = "cabane://actor/human/";

	export const fields = (defaults: Defaults): Field[] => [
		{ kind: "name" },
		...defaults.harnesses.map((harness): Field => ({
			kind: "harness",
			harness,
		})),
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
	 * what the old `kabane init --actor` asked a newcomer to type; here they type a name.
	 */
	export const actorSlug = (name: string): string =>
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "");

	/**
	 * The agent enter will file the first issue for, as the screen says it before enter: the first
	 * checked harness, and only inside a project, since the issue edits that project's files.
	 */
	export const firstAgent = (
		form: Form,
		defaults: Defaults,
	): string | undefined =>
		defaults.project === undefined
			? undefined
			: defaults.harnesses.find((h) => form.checked.includes(h.id))?.id;

	/**
	 * Who the first issue actually goes to: the first harness whose install landed. It can differ
	 * from `firstAgent` only when that one's install failed, and an agent without kabane's tools
	 * could never pick the issue up.
	 */
	export const firstIssueFor = (
		outcomes: readonly InstallOutcome[],
		defaults: Defaults,
	): string | undefined =>
		defaults.project === undefined
			? undefined
			: outcomes.find((o) => o.status !== "failed")?.id;

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
