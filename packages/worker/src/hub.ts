import { DurableObject } from "cloudflare:workers";

/**
 * The cloud device: runs the Cabane core on DO SQLite and serves MCP. Stub until
 * the DO SQLite Db adapter (JCAB-6) and the hub surface (JCAB-7) land.
 */
export class CabaneHub extends DurableObject<Cloudflare.Env> {
	ping(): "hub" {
		return "hub";
	}
}
