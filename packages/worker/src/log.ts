import { DurableObject } from "cloudflare:workers";

/**
 * The shared ordered oplog every device syncs through. Stub: the tables, push
 * and pull arrive with the sync log move (JCAB-6).
 *
 * A class, which the house style forbids: the platform requires extending
 * `DurableObject` to get `ctx`/`env` and RPC dispatch, so it is a framework
 * requirement, not a design choice. Logic lives in namespace modules this class
 * will delegate to.
 */
export class CabaneLog extends DurableObject<Cloudflare.Env> {
	ping(): "log" {
		return "log";
	}
}
