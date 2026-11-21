/** @jsxImportSource @opentui/react */
// A host asking a running board to open an issue (OpenRequests), against a real tracker: the board
// scoped to one project opens a done issue filed in another, from a search being typed, and `esc`
// lands on its row with every scope shown. The board only listens once it has loaded, and stops when
// it comes down. A host's job source puts the Jobs tab in the bar before the device has a job.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, Planner, type Task } from "@kabane/core";
import type { JobSource } from "@kabane/extension";
import { App } from "./app";
import { noActivity, type OpenRequests } from "./ports";
import { dropDb, freshDb } from "./test-db";
import { pumpUntil, renderTest } from "./testing";

const BASE = join(tmpdir(), `kabane-board-requests-${crypto.randomUUID()}`);
const HERE = "jake://scope/here";

let elsewhere: Task;

beforeAll(async () => {
	await freshDb(BASE);
	const local = await Planner.addTask(BASE, {
		title: "Work in this project",
		kind: "issue",
		state: "next",
		scopeUri: HERE,
	});
	if (!local.ok) throw local.error;
	const filed = await Planner.addTask(BASE, {
		title: "Shipped in another project",
		kind: "issue",
		state: "done",
		scopeUri: "jake://scope/there",
	});
	if (!filed.ok) throw filed.error;
	elsewhere = filed.value;
});

afterAll(() => dropDb(BASE));

it("opens a done issue from another scope over a search being typed, and esc lands on its row", async () => {
	let open: ((task: Task) => void) | undefined;
	let unsubscribed = false;
	const requests: OpenRequests = {
		subscribe: (listener) => {
			open = listener;
			return () => {
				unsubscribed = true;
			};
		},
	};
	const { renderOnce, captureCharFrame, mockInput, destroy } = await renderTest(
		<App
			cwd={BASE}
			basePath={BASE}
			activity={noActivity}
			resolveScope={async () => ({ scopeUri: HERE, label: "here" })}
			requests={requests}
		/>,
		{ width: 100, height: 30 },
	);
	const until = (p: (f: string) => boolean) =>
		pumpUntil(renderOnce, captureCharFrame, p);
	try {
		await until((f) => f.includes("Work in this project"));
		expect(open).toBeDefined();
		mockInput.pressKey("/");
		await mockInput.typeText("wor");
		await until((f) => f.includes("/wor"));
		open?.(elsewhere);
		const detail = await until(
			(f) => f.includes("Shipped in another project") && !f.includes("/wor"),
		);
		expect(detail).not.toContain("Work in this project");
		mockInput.pressEscape();
		const board = await until(
			(f) =>
				f.includes("kabane · all scopes") &&
				f.includes("Shipped in another project"),
		);
		expect(board).toContain(elsewhere.shortId ?? "");
	} finally {
		destroy();
	}
	expect(unsubscribed).toBe(true);
});

it("shows the Jobs tab with no job when the host has a job source, and not without one", async () => {
	const frameOf = async (jobs: JobSource | undefined) => {
		const { renderOnce, captureCharFrame, destroy } = await renderTest(
			<App
				cwd={BASE}
				basePath={BASE}
				activity={noActivity}
				{...(jobs ? { jobs } : {})}
				resolveScope={async () => ({ scopeUri: HERE, label: "here" })}
			/>,
			{ width: 40, height: 20 },
		);
		try {
			return await pumpUntil(renderOnce, captureCharFrame, (f) =>
				f.includes("Work in this project"),
			);
		} finally {
			destroy();
		}
	};
	expect(await frameOf({ facts: async () => ok({}) })).toContain(
		"1 tracker │ 2 jobs",
	);
	expect(await frameOf(undefined)).not.toContain("2 jobs");
});
