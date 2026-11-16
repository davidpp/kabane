import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { err, ok, type Result, trySync } from "@cabane/core";
import { type Doctor, type Extension, Settings } from "@cabane/extension";
import { ConfigSchema, configPath, isPlainObject } from "../config";
import { ConfigLayers } from "../config-layers";
import { ConfigSettings } from "../config-settings";
import { Extensions } from "../extensions";

const migrate = (
	home: string,
	scope: string,
	namespace: string,
	destination: string,
): Result<string> => {
	const path = configPath(home);
	const read = ConfigLayers.readJson(path);
	if (!read.ok) return read;
	const stored = read.value;
	if (!isPlainObject(stored) || !isPlainObject(stored.scopes))
		return err(new Error(`Refused: legacy scopes changed in ${path}`));
	const block = stored.scopes[scope];
	if (!isPlainObject(block) || !Object.hasOwn(block, namespace))
		return err(
			new Error(`Refused: legacy ${namespace} block changed in ${path}`),
		);
	const local = ConfigLayers.readJson(destination);
	if (!local.ok) return local;
	if (
		local.value !== undefined &&
		!isDeepStrictEqual(local.value, block[namespace])
	)
		return err(
			new Error(
				`Refused: ${destination} already holds a different value; legacy settings were left untouched`,
			),
		);
	const written = ConfigLayers.writeJson(destination, block[namespace]);
	if (!written.ok) return written;
	delete block[namespace];
	if (Object.keys(block).length === 0) delete stored.scopes[scope];
	if (Object.keys(stored.scopes).length === 0) delete stored.scopes;
	// config.json can be permission-restricted or managed through a symlink.
	const saved = trySync(() =>
		writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`),
	);
	return saved.ok
		? ok(`Moved scopes.${scope}.${namespace} to ${destination}`)
		: saved;
};

// Escape separators, capitals and the escape marker itself, so paths and layers cannot
// collide (a-b vs a.b, or a camelCase setting vs its lowercase spelling).
const idPart = (value: string): string =>
	Array.from(value, (char) =>
		/^[a-wyz0-9]$/.test(char) ? char : `x${char.codePointAt(0)?.toString(16)}x`,
	).join("") || "xemptyx";

// Only the storage owner knows which repairs are safe.
const drift = (
	namespace: Settings.Namespace,
	source: Settings.Source,
	path = source.label,
): Doctor.Finding[] =>
	Settings.drift(namespace.schema, source.value).map((finding) => {
		const key = [namespace.name, ...finding.path];
		const prefix = namespace.name === "device" ? [] : [namespace.name];
		const shown = [...prefix, ...finding.path].join(".");
		const detail =
			finding.category === "unknown"
				? namespace.name === "device"
					? "unknown device setting; kabane ignores this key"
					: "unknown setting; a strict extension schema rejects this layer until it is removed or corrected"
				: finding.replacement
					? `retired setting may map to ${[...prefix, ...finding.replacement].join(".")}`
					: "setting is no longer used";
		// A top-level block can be a disabled extension's settings, which stay for when it is
		// enabled again (docs/extensions.md), so this finding never advises removing one.
		const summary =
			finding.category === "unknown" &&
			namespace.name === "device" &&
			finding.path.length === 1
				? `${shown} in ${source.layer}: not a setting of this kabane or of an enabled extension; kabane ignores it. An extension's settings are kept for when it is enabled; correct the key in ${source.label} if it is misspelt.`
				: `${shown} in ${source.layer}: ${detail}. Edit ${source.label} to remove or correct this key${finding.replacement ? "; review the suggested replacement before removing the old key" : ""}.`;
		return {
			id: [
				`${finding.category}-setting`,
				source.layer,
				...key.map(idPart),
				createHash("sha256")
					.update(source.label ?? "")
					.digest("hex")
					.slice(0, 12),
			].join("-"),

			severity: "mention",
			path,
			summary,
		};
	});

export const settings = async (
	ctx: Extension.Ctx,
): Promise<Result<Doctor.Finding[]>> => {
	const path = configPath(ctx.home);
	const read = ConfigLayers.readJson(path);
	if (!read.ok) return read;
	const stored = read.value ?? {};
	if (!isPlainObject(stored))
		return err(new Error(`${path}: expected an object`));
	// A config that does not parse is this check's to report, so it enables no directory
	// extension here; known extension blocks are kept until their schemas can be loaded.
	const enabled = Extensions.enabled(ctx.home);
	const namespaces = await Extensions.namespaces(
		ctx.home,
		enabled.ok ? enabled : ok([]),
	);
	if (!namespaces.ok) return namespaces;
	const where = await ConfigSettings.locate(ctx.home, ctx.cwd);
	if (!where.ok) return where;
	// An installed or enabled extension's block is its own settings, checked against its schema
	// when it loads. A device key keeps the device check even when `extensions` names it.
	const extensionNames = new Set(
		[
			...Extensions.available(ctx.home),
			...(Array.isArray(stored.extensions)
				? stored.extensions.filter(
						(name): name is string => typeof name === "string",
					)
				: []),
		].filter((name) => !Object.hasOwn(ConfigSchema.shape, name)),
	);
	const device = Object.fromEntries(
		Object.entries(stored).filter(
			([key]) =>
				key !== "scopes" &&
				!extensionNames.has(key) &&
				!namespaces.value.some((ns) => ns.name === key),
		),
	);
	const findings = drift(
		{ name: "device", schema: ConfigSchema },
		{ layer: "global", label: path, value: device },
	);
	for (const namespace of namespaces.value) {
		// Legacy blocks are enumerated separately, including projects other than this one.
		const sources = ConfigLayers.sources(ctx.home, stored, namespace.name, {
			...where.value,
			scopeId: undefined,
		});
		if (!sources.ok) return sources;
		for (const source of sources.value)
			findings.push(...drift(namespace, source));
	}
	const legacy = legacySettings(
		ctx.home,
		stored.scopes,
		namespaces.value,
		where.value,
	);
	return legacy.ok ? ok([...findings, ...legacy.value]) : legacy;
};

const legacySettings = (
	home: string,
	scopes: unknown,
	namespaces: Settings.Namespace[],
	where: ConfigLayers.Where,
): Result<Doctor.Finding[]> => {
	const path = configPath(home);
	const findings: Doctor.Finding[] = [];
	if (scopes === undefined) return ok(findings);
	if (!isPlainObject(scopes))
		return err(new Error(`${path}: scopes must be an object`));
	for (const [scope, block] of Object.entries(scopes)) {
		if (!isPlainObject(block))
			return err(new Error(`${path}: scopes.${scope} must be an object`));
		for (const [name, value] of Object.entries(block)) {
			const namespace = namespaces.find((ns) => ns.name === name);
			const label = `${path} (scopes.${scope}.${name})`;
			if (namespace)
				findings.push(
					...drift(namespace, { layer: "local", label, value }, path),
				);
			const destination =
				namespace && scope === where.scopeId && where.localRoot !== undefined
					? ConfigLayers.localFile(home, where.localRoot, name)
					: undefined;
			const local =
				destination === undefined
					? ok(undefined)
					: ConfigLayers.readJson(destination);
			const conflict =
				!local.ok ||
				(local.value !== undefined && !isDeepStrictEqual(local.value, value));
			findings.push({
				id: `legacy-settings-${createHash("sha256")
					.update(JSON.stringify([scope, name]))
					.digest("hex")
					.slice(0, 12)}`,

				path,
				severity: destination === undefined || conflict ? "mention" : "auto",
				summary: `Legacy scopes.${scope}.${name} in ${path}. ${destination === undefined ? (namespace ? "Run kabane doctor in that project to migrate it." : "Run kabane doctor in that project with a version that ships this namespace to migrate it.") : conflict ? `Merge this block with ${destination} by hand, then remove the legacy block; the local file differs or cannot be read.` : `--fix moves this block to ${destination} and removes it from config.json; conflicting local values are refused.`}`,
				...(destination === undefined
					? {}
					: { fix: async () => migrate(home, scope, name, destination) }),
			});
		}
	}
	return ok(findings);
};
