export namespace CopilotInstructions {
	// The actor every write of this session is stamped with. `authorTypeOf` in the MCP tools reads
	// the `cabane://actor/agent/` prefix as `ai`, so the board can tell these writes from the human's.
	export const actorUri = (harness: string): string =>
		`cabane://actor/agent/${harness}`;

	// The name of the MCP server a kabane-launched session gets in session/new. It must not be the
	// `kabane` that `kabane mcp install` writes into the human's harness config: codex-acp drops a
	// session server whose name is already configured, and the session would then run the human's
	// own unscoped server against their default home. A cli test holds the two names apart. The
	// human's own server may still load beside this one, so the prompts name this one.
	export const SERVER_NAME = "kabane-session";
}
