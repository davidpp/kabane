import type { Doctor } from "@cabane/extension";
import { install } from "./install";
import { project } from "./project";
import { settings } from "./settings";

// Each check goes through the runner's error boundary independently.
export const kabane: Doctor.Source[] = [
	{ name: "kabane", doctor: settings },
	{ name: "project", doctor: project },
	{ name: "kabane", doctor: install },
];
