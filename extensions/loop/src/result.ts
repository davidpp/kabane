import type { Host } from "@cabane/extension";

// Only stateless result helpers are shared. Record, scope and settings stay on each host.
export let ok: Host["result"]["ok"];
export let err: Host["result"]["err"];
export let tryCatch: Host["result"]["tryCatch"];
export let trySync: Host["result"]["trySync"];

export namespace Kabane {
	export const bind = (host: Pick<Host, "result">): void => {
		({ ok, err, tryCatch, trySync } = host.result);
	};
}
