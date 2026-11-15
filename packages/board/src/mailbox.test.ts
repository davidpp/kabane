import { describe, expect, it } from "bun:test";
import { Mailbox } from "./mailbox";

// A promise that says whether it settled, without awaiting it.
const settled = (promise: Promise<void>): { done: boolean } => {
	const state = { done: false };
	void promise.then(() => {
		state.done = true;
	});
	return state;
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

describe("Mailbox", () => {
	it("hands everything queued back in arrival order, once", () => {
		const box = Mailbox.create<string>();
		box.push("a");
		box.push("b");
		expect(box.drain()).toEqual(["a", "b"]);
		expect(box.drain()).toEqual([]);
	});

	it("wakes whoever is waiting on the next push", async () => {
		const box = Mailbox.create<string>();
		const waiting = settled(box.filled());
		await tick();
		expect(waiting.done).toBe(false);
		box.push("a");
		await tick();
		expect(waiting.done).toBe(true);
	});

	// The deadlock guard: a caller that races `filled()` against a long read must never sleep on
	// items already in hand, whatever order it checked them in.
	it("is already filled when something is waiting to be drained", async () => {
		const box = Mailbox.create<string>();
		box.push("a");
		const waiting = settled(box.filled());
		await tick();
		expect(waiting.done).toBe(true);
	});
});
