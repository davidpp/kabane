/**
 * What a command returns: an exit code, a JSON value, and the human text. The
 * CLI prints one or the other (`--json`). Exit codes: 0 ok, 1 error, 2 usage.
 */

export type Outcome = {
	exitCode: 0 | 1 | 2;
	json: unknown;
	text: string;
	compact?: boolean;
};

export const success = (json: unknown, text: string): Outcome => ({
	exitCode: 0,
	json,
	text,
});

export const conciseSuccess = (json: unknown): Outcome => ({
	exitCode: 0,
	json,
	text: JSON.stringify(json),
	compact: true,
});

export const failure = (error: Error | string): Outcome => {
	const message = typeof error === "string" ? error : error.message;
	return { exitCode: 1, json: { error: message }, text: `Error: ${message}` };
};

export const usage = (message: string, usageLine: string): Outcome => ({
	exitCode: 2,
	json: { error: message, usage: usageLine },
	text: `Error: ${message}\nUsage: ${usageLine}`,
});
