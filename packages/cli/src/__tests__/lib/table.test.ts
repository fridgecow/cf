import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { escapeTerminalText } from "../../lib/ui/sanitize.js";
import { displayWidth, renderTable } from "../../lib/ui/table.js";
import type { TableColumn, TableOptions } from "../../lib/ui/table.js";

function render(
	columns: readonly TableColumn[],
	rows: readonly (readonly unknown[])[],
	options?: TableOptions
): string {
	return stripVTControlCharacters(renderTable(columns, rows, options));
}

describe("renderTable", () => {
	it("draws a box at natural width and right-aligns right columns", () => {
		expect(
			render(
				[{ name: "name" }, { name: "count", align: "right" }],
				[
					["a", 1],
					["bb", 22],
				]
			)
		).toBe(
			[
				"┌──────┬───────┐",
				"│ name │ count │",
				"├──────┼───────┤",
				"│ a    │     1 │",
				"│ bb   │    22 │",
				"└──────┴───────┘",
			].join("\n")
		);
	});

	it("renders nulls, scalars, and nested values", () => {
		expect(
			render(
				[{ name: "v" }],
				[[null], [undefined], [true], [12n], [{ a: [1, "x"] }], ["plain"]],
				{ nullText: "NULL" }
			)
		).toBe(
			[
				"┌───────────────┐",
				"│ v             │",
				"├───────────────┤",
				"│ NULL          │",
				"│ NULL          │",
				"│ true          │",
				"│ 12            │",
				'│ {"a":[1,"x"]} │',
				"│ plain         │",
				"└───────────────┘",
			].join("\n")
		);
	});

	it("escapes characters that would control the terminal", () => {
		const output = render(
			[{ name: "col\u001b[2J" }],
			[["a\nb\tc\u001b[31m\u202eevil"]]
		);
		expect(output).toContain(String.raw`│ col\x1b[2J `);
		expect(output).toContain(String.raw`│ a\nb\tc\x1b[31m\u202eevil │`);
		expect(output).not.toContain("\u202e");
		expect(output).not.toContain("\t");
		expect(output.split("\n")).toHaveLength(5);
	});

	it("leaves an empty table for no columns and a bare header for no rows", () => {
		expect(renderTable([], [["ignored"]])).toBe("");
		expect(render([{ name: "x" }, { name: "y" }], [])).toBe(
			["┌───┬───┐", "│ x │ y │", "└───┴───┘"].join("\n")
		);
	});

	it("narrows the widest column with an ellipsis to fit the terminal", () => {
		const lines = render(
			[{ name: "id" }, { name: "description" }],
			[["1", "x".repeat(50)]],
			{ width: 40 }
		).split("\n");

		expect(lines).toEqual([
			`┌────┬${"─".repeat(32)}┐`,
			`│ id │ description${" ".repeat(19)} │`,
			`├────┼${"─".repeat(32)}┤`,
			`│ 1  │ ${"x".repeat(29)}… │`,
			`└────┴${"─".repeat(32)}┘`,
		]);
		// The last terminal column stays free for consoles that wrap eagerly.
		for (const line of lines) {
			expect(displayWidth(line)).toBe(39);
		}
	});

	it("keeps columns that already fit at their natural width", () => {
		const lines = render(
			[{ name: "a" }, { name: "b" }, { name: "c" }],
			[["short", "y".repeat(40), "z".repeat(40)]],
			{ width: 60 }
		).split("\n");

		expect(lines[3]).toBe(
			`│ short │ ${"y".repeat(21)}… │ ${"z".repeat(21)}… │`
		);
		expect(displayWidth(lines[3] ?? "")).toBe(59);
	});

	it("switches to vertical records when narrowed columns still overflow", () => {
		const columns = ["a", "bb", "c", "d", "e"].map((name) => ({ name }));
		const row = columns.map((_, index) => `${index}${"v".repeat(40)}`);

		expect(render(columns, [row, row], { width: 30 })).toBe(
			[
				"Row 1:",
				"──────",
				`a:  0${"v".repeat(23)}…`,
				`bb: 1${"v".repeat(23)}…`,
				`c:  2${"v".repeat(23)}…`,
				`d:  3${"v".repeat(23)}…`,
				`e:  4${"v".repeat(23)}…`,
				"",
				"Row 2:",
				"──────",
				`a:  0${"v".repeat(23)}…`,
				`bb: 1${"v".repeat(23)}…`,
				`c:  2${"v".repeat(23)}…`,
				`d:  3${"v".repeat(23)}…`,
				`e:  4${"v".repeat(23)}…`,
			].join("\n")
		);
	});

	it("does not truncate when the terminal width is unknown", () => {
		const output = render([{ name: "x" }], [["y".repeat(500)]]);
		expect(output).toContain("y".repeat(500));
	});

	it("measures wide characters and emoji as two columns", () => {
		expect(
			render(
				[{ name: "城市" }, { name: "n", align: "right" }],
				[
					["東京", 1],
					["👨‍👩‍👧", 2],
				]
			)
		).toBe(
			[
				"┌──────┬───┐",
				"│ 城市 │ n │",
				"├──────┼───┤",
				"│ 東京 │ 1 │",
				"│ 👨‍👩‍👧   │ 2 │",
				"└──────┴───┘",
			].join("\n")
		);
	});

	it("never splits a wide character when truncating", () => {
		const lines = render([{ name: "c" }], [["日本語日本語日本語日本語"]], {
			width: 16,
		}).split("\n");
		expect(lines[3]).toBe("│ 日本語日本… │");
	});
});

describe("displayWidth", () => {
	it.each([
		["ascii", "hello", 5],
		["combining marks", "e\u0301", 1],
		["CJK", "日本", 4],
		["fullwidth forms", "ＡＢ", 4],
		["emoji presentation", "🚀", 2],
		["ZWJ sequence", "👩‍💻", 2],
		["text emoji with VS16", "❤️", 2],
		["text emoji without VS16", "©", 1],
		["flag", "🇬🇧", 2],
		["zero-width space", "a\u200bb", 2],
	])("measures %s", (_name, text, width) => {
		expect(displayWidth(text)).toBe(width);
	});
});

describe("escapeTerminalText", () => {
	it("escapes controls, separators, and bidi formatting", () => {
		expect(
			escapeTerminalText(
				"\u0000\u0007\u007f\u009b\u2028\u2029\u200e\u202e\u2066"
			)
		).toBe(String.raw`\x00\x07\x7f\x9b\u2028\u2029\u200e\u202e\u2066`);
	});

	it("uses short escapes for newlines, carriage returns, and tabs", () => {
		expect(escapeTerminalText("a\nb\rc\td")).toBe(String.raw`a\nb\rc\td`);
	});

	it("keeps joiners and requested characters", () => {
		expect(escapeTerminalText("👩‍💻")).toBe("👩‍💻");
		expect(escapeTerminalText("a\tb\nc\u001b", "\t\n")).toBe("a\tb\nc\\x1b");
	});
});
