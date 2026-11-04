import type { CliRenderer } from "@opentui/core";

/**
 * Destroy `renderer` and wait until it has let go of the terminal. Teardown finishes behind
 * `closed`: until it settles the terminal is not restored, a next renderer cannot take stdin, and
 * the process must not exit. It rejects only when the output failed, and then there is no terminal
 * left to restore.
 */
export const closeRenderer = async (renderer: CliRenderer): Promise<void> => {
	renderer.destroy();
	await renderer.closed.catch(() => {});
};
