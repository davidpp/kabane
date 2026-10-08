import { tryCatch, type Result } from "../result";

/** Fixed-size bindings/revisions shared by stateless bounded reads in both runtimes. */
export const fingerprintText = (text: string): Promise<Result<string>> =>
	tryCatch(async () =>
		Array.from(
			new Uint8Array(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
			),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join(""),
	);
