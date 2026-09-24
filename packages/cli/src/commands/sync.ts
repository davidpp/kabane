import { Backfill, Sync, SyncDevice, type SyncStatus } from "@cabane/core";
import type { Config } from "../config";
import type { Command, Ctx } from "../context";
import { failure, success, usage } from "../output";

/**
 * A database opened through `db.path` usually belongs to another host (Jake)
 * that already syncs it as its own device. Syncing the same file from here too
 * would race that device on the shared `sync_state` row.
 */
export const sharedDbWarning = (config: Config): string | undefined =>
	config.db?.path !== undefined && config.sync.enabled
		? `⚠️  db.path points at ${config.db.path}, which another host may already sync as its own device. Sync from that host instead, or drop the sync block from this config.`
		: undefined;

const withWarning = (ctx: Ctx, text: string): string => {
	const warning = sharedDbWarning(ctx.config);
	return warning ? `${warning}\n${text}` : text;
};

const formatStatus = (s: SyncStatus): string => {
	if (!s.enabled)
		return "Sync: not armed on this device (run `kabane sync push` once with sync configured).";
	const lines = [
		`Sync: armed as device ${s.deviceId}`,
		`  pending ops:     ${s.pendingOps}`,
		`  last pushed seq: ${s.lastPushedSeq}`,
		`  last applied seq:${s.lastAppliedSeq}`,
		`  last sync:       ${s.lastSyncAt ?? "never"}`,
		`  renamed ids:     ${s.renamedShortIds}`,
		`  quarantined:     ${s.quarantinedOps}`,
	];
	for (const q of s.quarantined) lines.push(`    - ${q.opId} ${q.reason}`);
	return lines.join("\n");
};

export const sync: Command = {
	name: "sync",
	summary: "Replicate with the shared log: status, push, pull, backfill",
	usage: "kabane sync [status|push|pull|backfill]",
	run: async (args, ctx) => {
		const sub = args.positionals[0] ?? "status";

		if (sub === "status") {
			const status = await Sync.status(ctx.store);
			if (!status.ok) return failure(status.error);
			return success(
				{ ...status.value, warning: sharedDbWarning(ctx.config) },
				withWarning(ctx, formatStatus(status.value)),
			);
		}
		if (sub !== "push" && sub !== "pull" && sub !== "backfill") {
			return usage(`Unknown sync subcommand: ${sub}`, sync.usage);
		}

		const connected = await SyncDevice.connect(ctx.store);
		if (!connected.ok) return failure(connected.error);
		const { transport, deviceId } = connected.value;

		if (sub === "pull") {
			const pulled = await Sync.pull(ctx.store, transport);
			if (!pulled.ok) return failure(pulled.error);
			const r = pulled.value;
			return success(
				{ deviceId, ...r },
				withWarning(
					ctx,
					`⬇️  Pulled ${r.received} ops, applied ${r.applied}, renamed ${r.renamed} (${r.batches} batches, through seq ${r.throughSeq})`,
				),
			);
		}

		let backfilled = "";
		if (sub === "backfill") {
			const report = await Backfill.run(ctx.store);
			if (!report.ok) return failure(report.error);
			backfilled = `📦 Backfilled ${report.value.written} rows into the oplog (${report.value.alreadyPresent} already present)\n`;
		}
		const pushed = await Sync.push(ctx.store, transport);
		if (!pushed.ok) return failure(pushed.error);
		const r = pushed.value;
		return success(
			{ deviceId, ...r },
			withWarning(
				ctx,
				`${backfilled}⬆️  Pushed ${r.pushed} ops (${r.duplicates} duplicates, ${r.batches} batches) as device ${deviceId}`,
			),
		);
	},
};
