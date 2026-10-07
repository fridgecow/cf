import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { outputPostProcessor } from "../../commands/sql/query/output.js";
import type { CloudflareApi } from "#sdk";

/**
 * Unit tests for the SQL query table view. The fixtures are typed against
 * the SDK's response schemas, so a spec change to the response shapes fails
 * type checking here: the renderer must be revisited, not just the fixture.
 */
function render(data: unknown, columns?: number): string | undefined {
	const output = outputPostProcessor(data, { columns });
	return output === undefined ? undefined : stripVTControlCharacters(output);
}

const defaultResponse = {
	data: [
		{ blob1: "bar", count: 12, ratio: 0.5 },
		{ blob1: "foo", count: 3, ratio: null },
	],
	rows: 2,
	statistics: { elapsed_ms: 135, rows_read: 100_000, bytes_read: 104_857_600 },
} satisfies CloudflareApi.AnalyticsSqlSqlQueryResponse;

const formatJsonResponse = {
	meta: [
		{ name: "label", type: "LowCardinality(String)" },
		{ name: "total", type: "UInt64" },
		{ name: "avg", type: "Nullable(Float64)" },
	],
	data: [{ avg: 1.5, label: "bar-1", total: "18446744073709551615" }],
	rows: 1,
	rows_before_limit_at_least: 41,
	statistics: { elapsed_ms: 7, rows_read: 11, bytes_read: 13 },
} satisfies CloudflareApi.AnalyticsSqlClickHouseJsonQueryResponse;

const logExplorerResponse = {
	data: [{ count: 3, name: "example" }],
	rows: 1,
} satisfies CloudflareApi.AnalyticsSqlLogExplorerQueryResponse;

describe("SQL query output", () => {
	it("renders the default response with statistics", () => {
		expect(render(defaultResponse)).toBe(
			[
				"┌───────┬───────┬───────┐",
				"│ blob1 │ count │ ratio │",
				"├───────┼───────┼───────┤",
				"│ bar   │    12 │   0.5 │",
				"│ foo   │     3 │  NULL │",
				"└───────┴───────┴───────┘",
				"",
				"2 rows in set. Elapsed: 135 ms. Read 100,000 rows, 104.86 MB.",
			].join("\n")
		);
	});

	it("orders FORMAT JSON columns by meta and aligns quoted 64-bit integers", () => {
		expect(render(formatJsonResponse)).toBe(
			[
				"┌───────┬──────────────────────┬─────┐",
				"│ label │                total │ avg │",
				"├───────┼──────────────────────┼─────┤",
				"│ bar-1 │ 18446744073709551615 │ 1.5 │",
				"└───────┴──────────────────────┴─────┘",
				"",
				"1 row in set (at least 41 before LIMIT). Elapsed: 7 ms. Read 11 rows, 13 B.",
			].join("\n")
		);
	});

	it("renders Log Explorer responses without statistics", () => {
		expect(render(logExplorerResponse)).toBe(
			[
				"┌───────┬─────────┐",
				"│ count │ name    │",
				"├───────┼─────────┤",
				"│     3 │ example │",
				"└───────┴─────────┘",
				"",
				"1 row in set.",
			].join("\n")
		);
	});

	it("keeps FORMAT JSON headers for an empty result", () => {
		expect(
			render({
				...formatJsonResponse,
				data: [],
				rows: 0,
				rows_before_limit_at_least: 0,
			})
		).toBe(
			[
				"┌───────┬───────┬─────┐",
				"│ label │ total │ avg │",
				"└───────┴───────┴─────┘",
				"",
				"0 rows in set. Elapsed: 7 ms. Read 11 rows, 13 B.",
			].join("\n")
		);
	});

	it("summarises an empty default result without a table", () => {
		expect(
			render({
				data: [],
				rows: 0,
				statistics: { elapsed_ms: 1_234, rows_read: 0, bytes_read: 0 },
			})
		).toBe("0 rows in set. Elapsed: 1.23 s.");
	});

	it("does not treat numeric-looking strings in untyped columns as numbers", () => {
		const output = render({
			data: [{ id: "0012" }, { id: "7" }],
			rows: 2,
		});
		expect(output).toContain("│ 0012 │");
		expect(output).toContain("│ 7    │");
	});

	it("shows nested values as compact JSON", () => {
		expect(
			render({ data: [{ tags: ["bar", "foo"] }], rows: 1 })?.split("\n")[3]
		).toBe('│ ["bar","foo"] │');
	});

	it("switches to vertical records when the columns cannot fit", () => {
		const row = Object.fromEntries(
			Array.from({ length: 8 }, (_, index) => [
				`column_${index}`,
				"x".repeat(30),
			])
		);
		const output = render({ data: [row], rows: 1 }, 60) ?? "";

		expect(output.split("\n").slice(0, 3)).toEqual([
			"Row 1:",
			"──────",
			`column_0: ${"x".repeat(30)}`,
		]);
		expect(output).toContain("1 row in set.");
	});

	it("prints text formats as received, escaping terminal controls", () => {
		expect(render("foo-1\tfoo\nfoo-2\tfo\u001b[2Jo\n")).toBe(
			"foo-1\tfoo\nfoo-2\tfo\\x1b[2Jo"
		);
		expect(render('{"a":1}\n{"a":2}\n')).toBe('{"a":1}\n{"a":2}');
	});

	it.each([
		["a scalar", 42],
		["an array", [1, 2]],
		["an object without rows", { result: [] }],
		["rows that are not objects", { data: [1, 2], rows: 2 }],
	])("declines %s so the JSON is printed", (_name, data) => {
		expect(render(data)).toBeUndefined();
	});
});
