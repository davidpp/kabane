/**
 * The names both the edge and the objects agree on.
 *
 * One log, one hub, named for the thing rather than for a person, so a second
 * user would be `getByName(userId)` and nothing else changes.
 */

/** The `CabaneLog` instance every device syncs through. */
export const SHARED_LOG = "cabane";

/** The `CabaneHub` instance serving MCP. */
export const HUB_NAME = "cabane";

/** The hub's identity in the log, as a sync device. */
export const HUB_DEVICE_ID = "cloud";

/**
 * How the edge tells the hub who is calling. Set by `index.ts` after Access
 * verification and never trusted from outside: the object is only reachable
 * through the edge, which overwrites whatever a client sent.
 */
export const ACTOR_HEADER = "X-Cabane-Actor";
