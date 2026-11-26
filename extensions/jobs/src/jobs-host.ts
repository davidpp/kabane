// The host as the jobs extension takes it: with the device id every run is stamped with and
// compared against. The OS hostname follows the network on macOS, so it cannot say which device
// a run is on (JCAB-127).
import type { Host } from "@kabane/extension";

export type JobsHost = Host & { readonly device: string };

/** `host` with its device id; a host older than `device` cannot run jobs, so the factory throws. */
export const jobsHost = (host: Host): JobsHost => {
	const { device } = host;
	if (device === undefined)
		throw new Error(
			"jobs needs a kabane that gives extensions the device id; update kabane",
		);
	return { ...host, device };
};
