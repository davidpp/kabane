/** `YYYY-MM-DD` or a full ISO string into the ISO datetime the schema wants. */
export const toDeadline = (input: string | undefined): string | undefined => {
	if (input === undefined) return undefined;
	const date = /^\d{4}-\d{2}-\d{2}$/.test(input)
		? new Date(`${input}T23:59:59.000Z`)
		: new Date(input);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};
