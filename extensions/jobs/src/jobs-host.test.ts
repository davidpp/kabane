import { expect, it } from "bun:test";
import type { Host } from "@kabane/extension";
import { jobsHost } from "./jobs-host";

it("takes the host's device id, and refuses a host older than it", () => {
	const host = { api: 1, device: "studio" } as unknown as Host;
	expect(jobsHost(host).device).toBe("studio");
	expect(() => jobsHost({ api: 1 } as unknown as Host)).toThrow(
		"jobs needs a kabane that gives extensions the device id; update kabane",
	);
});
