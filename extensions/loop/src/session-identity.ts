// Keep session tools distinct from the human's configured kabane MCP server.
export const SERVER_NAME = "kabane-session";
export const actorUri = (harness: string): string =>
	`kabane://actor/agent/${harness}`;
