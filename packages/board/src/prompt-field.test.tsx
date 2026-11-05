/** @jsxImportSource @opentui/react */
import { describe, expect, it } from "bun:test";
import type { TextareaRenderable } from "@opentui/core";
import { createRef } from "react";
import { PromptField } from "./prompt-field";
import { renderTest } from "./testing";

describe("prompt field wrapping preserves the prefix and padding", () => {
	for (const width of [38, 39, 40, 41, 42, 43, 44, 45]) {
		for (const { name, placeholder, initialValue } of [
			{
				name: "running hint",
				placeholder: "a turn is running · send when it ends",
				initialValue: "",
			},
			{
				name: "idle placeholder",
				placeholder: "ask about the selection · / for shortcuts",
				initialValue: "",
			},
			{
				name: "draft",
				placeholder: "",
				initialValue: "plan the migration for all our readers",
			},
			{ name: "unbroken draft", placeholder: "", initialValue: "x".repeat(50) },
		]) {
			it(`${name} at ${width} columns`, async () => {
				const { captureCharFrame, destroy } = await renderTest(
					<PromptField
						textareaRef={createRef<TextareaRenderable>()}
						initialValue={initialValue}
						placeholder={placeholder}
						rows={3}
						onSubmit={() => {}}
						onContentChange={() => {}}
					/>,
					{ width, height: 3 },
				);
				try {
					const rows = captureCharFrame().split("\n").slice(0, 3);
					expect(rows[0]).toMatch(/^ ▸ \S/);
					for (const row of rows) {
						expect(row).toHaveLength(width);
						expect(row[0]).toBe(" ");
						expect(row[width - 1]).toBe(" ");
					}
					for (const row of rows.slice(1)) expect(row.slice(0, 3)).toBe("   ");
					// Wrapping must retain all the content, including an unbroken draft.
					expect(
						rows
							.map((row) => row.slice(3).trim())
							.join("")
							.replaceAll(" ", ""),
					).toBe((initialValue || placeholder).replaceAll(" ", ""));
				} finally {
					destroy();
				}
			});
		}
	}
});
