/**
 * @cabane/acp
 *
 * Agent Client Protocol client for the board copilot: a harness registry, the stdio
 * adapters a Bun subprocess needs, and a small session runner whose update stream is
 * cabane's own so nothing downstream imports the SDK.
 */

export { AcpClient } from "./src/client";
export { Harnesses } from "./src/harnesses";
export { Stdio } from "./src/stdio";
