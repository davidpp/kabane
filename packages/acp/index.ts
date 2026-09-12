/**
 * @cabane/acp
 *
 * Agent Client Protocol client for the board copilot: a harness registry, the stdio
 * adapters a Bun subprocess needs, and a small session runner whose update stream is
 * cabane's own so nothing downstream imports the SDK. BoardCopilot puts those together
 * as the board's Copilot port, with `cabane mcp` as the session's one tool server.
 */

export { AcpClient } from "./src/client";
export { BoardCopilot } from "./src/copilot";
export { Harnesses } from "./src/harnesses";
export { CopilotInstructions } from "./src/instructions";
export { Stdio } from "./src/stdio";
