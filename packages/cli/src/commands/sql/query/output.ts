/**
 * Table view of SQL API query results.
 *
 * Registered against the `sql-api-query-post` operation in
 * `commands/hand-written.ts`. The generated leaf passes its result here only
 * in an interactive terminal; pipes, CI, agents, and `--json` still receive
 * the JSON body, so this view is free to truncate and reformat.
 */

import type { OutputPostProcessor } from "#lib/output.js";
import type { TableColumn } from "#lib/ui/table.js";
import { escapeTerminalText } from "#lib/ui/sanitize.js";
import { renderTable } from "#lib/ui/table.js";
import { theme } from "#lib/ui/theme.js";

type JsonObject = Record<string, unknown>;

/**
 * Every JSON response variant: the default body, `FORMAT JSON` (adds `meta`
 * and `rows_before_limit_at_least`), and Log Explorer (no `statistics`).
 */
interface QueryResult {
	data: JsonObject[];
	meta?: unknown;
	rows_before_limit_at_least?: unknown;
	statistics?: unknown;
}

interface Column {
	name: string;
	type: string | undefined;
}

const NUMERIC_TYPE =
	/^(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|BFloat16|Decimal(?:32|64|128|256)?\(.*\))$/;
const TYPE_WRAPPER = /^(?:Nullable|LowCardinality)\((.*)\)$/;
const COUNT = new Intl.NumberFormat("en-US");
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isQueryResult(value: unknown): value is QueryResult {
	return (
		isObject(value) && Array.isArray(value.data) && value.data.every(isObject)
	);
}

/**
 * `FORMAT JSON` describes the columns in SELECT order. Default responses
 * carry no `meta`, and the API serialises their row keys alphabetically, so
 * those columns follow the rows' key order.
 */
function resultColumns(result: QueryResult): Column[] {
	const columns = new Map<string, string | undefined>();
	if (Array.isArray(result.meta)) {
		for (const entry of result.meta) {
			if (
				isObject(entry) &&
				typeof entry.name === "string" &&
				!columns.has(entry.name)
			) {
				columns.set(
					entry.name,
					typeof entry.type === "string" ? entry.type : undefined
				);
			}
		}
	}
	for (const row of result.data) {
		for (const name of Object.keys(row)) {
			if (!columns.has(name)) {
				columns.set(name, undefined);
			}
		}
	}
	return Array.from(columns, ([name, type]) => ({ name, type }));
}

function isNumericType(type: string): boolean {
	let current = type.trim();
	for (
		let wrapped = TYPE_WRAPPER.exec(current);
		wrapped !== null;
		wrapped = TYPE_WRAPPER.exec(current)
	) {
		current = (wrapped[1] ?? "").trim();
	}
	return NUMERIC_TYPE.test(current);
}

/**
 * Typed columns follow their ClickHouse type, so 64-bit integers that
 * `FORMAT JSON` quotes still align as numbers. Untyped columns are numeric
 * when every value present is a JSON number.
 */
function isNumericColumn(column: Column, rows: readonly JsonObject[]): boolean {
	if (column.type !== undefined) {
		return isNumericType(column.type);
	}
	let sawNumber = false;
	for (const row of rows) {
		const value = row[column.name];
		if (value === null || value === undefined) {
			continue;
		}
		if (typeof value !== "number") {
			return false;
		}
		sawNumber = true;
	}
	return sawNumber;
}

function plural(count: number, noun: string): string {
	return `${COUNT.format(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
		value /= 1000;
		unit++;
	}
	return unit === 0
		? `${value} B`
		: `${value.toFixed(2)} ${BYTE_UNITS[unit] ?? ""}`;
}

function formatElapsed(milliseconds: number): string {
	return milliseconds < 1000
		? `${milliseconds} ms`
		: `${(milliseconds / 1000).toFixed(2)} s`;
}

function summary(result: QueryResult): string {
	const rows = result.data.length;
	let count = `${plural(rows, "row")} in set`;
	const beforeLimit = result.rows_before_limit_at_least;
	if (typeof beforeLimit === "number" && beforeLimit > rows) {
		count += ` (at least ${COUNT.format(beforeLimit)} before LIMIT)`;
	}
	const parts = [`${count}.`];
	const statistics = isObject(result.statistics) ? result.statistics : {};
	const {
		elapsed_ms: elapsed,
		rows_read: rowsRead,
		bytes_read: bytesRead,
	} = statistics;
	if (typeof elapsed === "number") {
		parts.push(`Elapsed: ${formatElapsed(elapsed)}.`);
	}
	// A missing ClickHouse summary is reported as zero rows and bytes read.
	if (
		typeof rowsRead === "number" &&
		typeof bytesRead === "number" &&
		(rowsRead > 0 || bytesRead > 0)
	) {
		parts.push(`Read ${plural(rowsRead, "row")}, ${formatBytes(bytesRead)}.`);
	}
	return theme.muted(parts.join(" "));
}

export const outputPostProcessor: OutputPostProcessor = (data, context) => {
	// `FORMAT TSV` and `FORMAT JSONEachRow` arrive as text. Print them as
	// received rather than as a quoted JSON string, keeping only the tabs
	// and newlines that structure them.
	if (typeof data === "string") {
		return escapeTerminalText(data.replace(/\n$/, ""), "\t\n");
	}
	if (!isQueryResult(data)) {
		return undefined;
	}
	const columns = resultColumns(data);
	const table = renderTable(
		columns.map((column): TableColumn => ({
			name: column.name,
			align: isNumericColumn(column, data.data) ? "right" : "left",
		})),
		data.data.map((row) => columns.map((column) => row[column.name])),
		{ width: context.columns, nullText: "NULL" }
	);
	return table === "" ? summary(data) : `${table}\n\n${summary(data)}`;
};
