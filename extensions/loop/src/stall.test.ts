import { describe, expect, it } from "bun:test";
import { Stall } from "./stall";

describe("Stall", () => {
	it("stalls after N session ends in a row with the same mark", () => {
		let state = Stall.start(Stall.mark([], "tree0"));
		state = Stall.observe(state, Stall.mark([], "tree0"));
		state = Stall.observe(state, Stall.mark([], "tree0"));
		expect(Stall.stalled(state, 3)).toBe(false);
		state = Stall.observe(state, Stall.mark([], "tree0"));
		expect(Stall.stalled(state, 3)).toBe(true);
	});

	it("resets on progress: a closed subtask or a changed tree", () => {
		let state = Stall.start(Stall.mark([], "tree0"));
		state = Stall.observe(state, Stall.mark([], "tree0"));
		state = Stall.observe(state, Stall.mark([], "tree0"));
		state = Stall.observe(state, Stall.mark(["a"], "tree0"));
		expect(state.unchanged).toBe(0);
		state = Stall.observe(state, Stall.mark(["a"], "tree0"));
		state = Stall.observe(state, Stall.mark(["a"], "tree1"));
		expect(state.unchanged).toBe(0);
	});

	it("does not depend on the order closed subtasks are listed in", () => {
		expect(Stall.mark(["b", "a"], "t")).toBe(Stall.mark(["a", "b"], "t"));
	});
});
