// Format elapsed time from ISO timestamp to a human-readable string.
export const elapsed = (startedAt: string, finishedAt?: string): string => {
	const start = Date.parse(startedAt);
	const end = finishedAt ? Date.parse(finishedAt) : Date.now();
	const ms = end - start;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000)
		return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
	return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
};
