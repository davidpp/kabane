/**
 * Bindings, mirroring `wrangler.jsonc`.
 *
 * Hand-written rather than `wrangler types`: secrets never appear in the config
 * file, so a generated `Env` would silently omit them once they exist.
 *
 * No top-level `import` here on purpose: that would make this a module and the
 * declaration would stop merging into the ambient `Cloudflare` namespace.
 */
declare namespace Cloudflare {
	interface Env {
		CABANE_LOG: DurableObjectNamespace<import("./log").CabaneLog>;
		CABANE_HUB: DurableObjectNamespace<import("./hub").CabaneHub>;
	}
}
