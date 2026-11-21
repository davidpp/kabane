// config.json's actor under the prefix kabane no longer reads. Every other process refuses to
// start on one (`openContext`); doctor still runs, migrates the database, and rewrites it here.
import { existsSync } from "node:fs";
import { ActorScheme, err, ok, type Result } from "@kabane/core";
import type { Doctor, Extension } from "@kabane/extension";
import { configPath, loadConfigDocument, saveConfig } from "../config";

export const configActor = async (
	ctx: Extension.Ctx,
): Promise<Result<Doctor.Finding[]>> => {
	if (!existsSync(configPath(ctx.home))) return ok([]);
	const document = loadConfigDocument(ctx.home);
	// An unreadable config is the settings check's finding.
	if (!document.ok) return ok([]);
	const { actor } = document.value.config;
	if (!ActorScheme.isLegacy(actor)) return ok([]);
	const renamed = ActorScheme.current(actor);
	return ok([
		{
			id: "config-actor-legacy",
			severity: "auto",
			path: configPath(ctx.home),
			summary: `config.json's actor is ${actor}, under the ${ActorScheme.LEGACY_PREFIX} prefix kabane no longer reads; --fix rewrites it to ${renamed}.`,
			// Read again: another repair of this run may have rewritten config.json since.
			fix: async () => {
				const now = loadConfigDocument(ctx.home);
				if (!now.ok) return now;
				if (now.value.config.actor !== actor)
					return err(
						new Error(
							`Refused: config.json's actor changed to ${now.value.config.actor} since doctor read it`,
						),
					);
				const written = saveConfig(ctx.home, {
					...now.value.stored,
					actor: renamed,
				});
				return written.ok ? ok(`actor is now ${renamed}`) : written;
			},
		},
	]);
};
