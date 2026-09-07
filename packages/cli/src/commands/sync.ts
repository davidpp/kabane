import { Backfill, Sync, SyncDevice, type SyncStatus } from "@cabane/core";
import type { Command } from "../context";
import { failure, success, usage } from "../output";

const formatStatus = (s: SyncStatus): string => {
	if (!s.enabled)
		return "Sync: not armed on this device (run `cabane sync push` once with sync configured).";
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
	usage: "cabane sync [status|push|pull|backfill]",
	run: async (args, ctx) => {
		const sub = args.positionals[0] ?? "status";

		if (sub === "status") {
			const status = await Sync.status(ctx.home);
			if (!status.ok) return failure(status.error);
			return success(status.value, formatStatus(status.value));
		}
		if (sub !== "push" && sub !== "pull" && sub !== "backfill") {
			return usage(`Unknown sync subcommand: ${sub}`, sync.usage);
		}

		const connected = await SyncDevice.connect(ctx.home);
		if (!connected.ok) return failure(connected.error);
		const { transport, deviceId } = connected.value;

		if (sub === "pull") {
			const pulled = await Sync.pull(ctx.home, transport);
			if (!pulled.ok) return failure(pulled.error);
			const r = pulled.value;
			return success(
				{ deviceId, ...r },
				`⬇️  Pulled ${r.received} ops, applied ${r.applied}, renamed ${r.renamed} (${r.batches} batches, through seq ${r.throughSeq})`,
			);
		}

		let backfilled = "";
		if (sub === "backfill") {
			const report = await Backfill.run(ctx.home);
			if (!report.ok) return failure(report.error);
			backfilled = `📦 Backfilled ${report.value.written} rows into the oplog (${report.value.alreadyPresent} already present)\n`;
		}
		const pushed = await Sync.push(ctx.home, transport);
		if (!pushed.ok) return failure(pushed.error);
		const r = pushed.value;
		return success(
			{ deviceId, ...r },
			`${backfilled}⬆️  Pushed ${r.pushed} ops (${r.duplicates} duplicates, ${r.batches} batches) as device ${deviceId}`,
		);
	},
};
