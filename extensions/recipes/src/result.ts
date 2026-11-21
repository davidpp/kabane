import type { Host } from "@kabane/extension";

// Only stateless result helpers are shared, bound from the host by the factory's first call.
export let ok: Host["result"]["ok"];
export let err: Host["result"]["err"];
export let trySync: Host["result"]["trySync"];
export let tryCatch: Host["result"]["tryCatch"];

export namespace Kabane {
	export const bind = (host: Pick<Host, "result">): void => {
		({ ok, err, trySync, tryCatch } = host.result);
	};
}
