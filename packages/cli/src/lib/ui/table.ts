/**
 * Box-drawn tables for showing structured results to people on a terminal.
 *
 *   ┌──────┬───────┐
 *   │ name │ count │
 *   ├──────┼───────┤
 *   │ a    │     1 │
 *   └──────┴───────┘
 *
 * Product-agnostic: callers supply column names and raw cell values; this
 * module owns escaping, display width, alignment, and fitting the table to
 * the terminal. Tables are a lossy view: cells are truncated to fit, and
 * when even narrowed columns cannot fit, rows are rendered as vertical
 * records instead. JSON remains the machine-readable output.
 */
import { escapeTerminalText } from "./sanitize.js";
import { theme } from "./theme.js";

export interface TableColumn {
	name: string;
	align?: "left" | "right";
}

export interface TableOptions {
	/** Terminal width in columns. Nothing is truncated when unknown. */
	width?: number;
	/** Text shown, muted, for null and undefined cells. */
	nullText?: string;
}

interface Cell {
	text: string;
	muted: boolean;
}

/** Columns are not narrowed below this width to make a table fit. */
const MIN_COLUMN_WIDTH = 10;

const ELLIPSIS = "…";

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EMOJI = /^\p{Emoji}/u;
// East Asian Wide and Fullwidth blocks: Hangul, CJK, kana, Yi, fullwidth
// forms, and the supplementary ideographic planes.
const WIDE =
	/^[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{16fe0}-\u{16fe4}\u{17000}-\u{18cff}\u{1b000}-\u{1b2ff}\u{1f200}-\u{1f2ff}\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]/u;

let segmenter: Intl.Segmenter | undefined;

function graphemes(text: string): string[] {
	segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
	return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

function graphemeWidth(grapheme: string): number {
	if (ZERO_WIDTH.test(grapheme)) {
		return 0;
	}
	if (
		EMOJI_PRESENTATION.test(grapheme) ||
		WIDE.test(grapheme) ||
		(grapheme.includes("\ufe0f") && EMOJI.test(grapheme))
	) {
		return 2;
	}
	return 1;
}

/** Terminal columns occupied by already-escaped text. */
export function displayWidth(text: string): number {
	if (ASCII_PRINTABLE.test(text)) {
		return text.length;
	}
	let width = 0;
	for (const grapheme of graphemes(text)) {
		width += graphemeWidth(grapheme);
	}
	return width;
}

function truncate(text: string, width: number): string {
	if (displayWidth(text) <= width) {
		return text;
	}
	let kept = "";
	let used = 0;
	for (const grapheme of graphemes(text)) {
		const next = graphemeWidth(grapheme);
		if (used + next > width - 1) {
			break;
		}
		kept += grapheme;
		used += next;
	}
	return `${kept}${ELLIPSIS}`;
}

function formatCell(value: unknown, nullText: string): Cell {
	if (value === null || value === undefined) {
		return { text: escapeTerminalText(nullText), muted: true };
	}
	if (typeof value === "string") {
		return { text: escapeTerminalText(value), muted: false };
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return { text: String(value), muted: false };
	}
	// Arrays and objects. Values JSON cannot represent are left blank.
	return {
		text: escapeTerminalText(JSON.stringify(value) ?? ""),
		muted: false,
	};
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

/**
 * Shrink the widest columns first: find the largest cap that fits, keeping
 * every column at least at its minimum, then hand the remainder out one
 * column at a time.
 */
function fitWidths(
	natural: readonly number[],
	minimum: readonly number[],
	available: number
): number[] {
	const capped = (cap: number) =>
		natural.map((width, index) =>
			Math.min(width, Math.max(cap, minimum[index] ?? 1))
		);
	let low = 0;
	let high = Math.max(...natural);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (sum(capped(middle)) <= available) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	const widths = capped(low);
	let spare = available - sum(widths);
	for (let index = 0; index < widths.length && spare > 0; index++) {
		const width = widths[index] ?? 0;
		if (width < (natural[index] ?? 0)) {
			widths[index] = width + 1;
			spare--;
		}
	}
	return widths;
}

function styled(cell: Cell, header: boolean): string {
	if (header) {
		return theme.bold(cell.text);
	}
	return cell.muted ? theme.muted(cell.text) : cell.text;
}

function renderGrid(
	columns: readonly TableColumn[],
	headers: readonly Cell[],
	rows: readonly (readonly Cell[])[],
	widths: readonly number[]
): string {
	const rule = (left: string, middle: string, right: string) =>
		theme.muted(
			`${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`
		);
	const line = (cells: readonly Cell[], header: boolean) => {
		const rendered = cells.map((cell, index) => {
			const width = widths[index] ?? 0;
			const text = truncate(cell.text, width);
			const padding = " ".repeat(width - displayWidth(text));
			const content = styled({ ...cell, text }, header);
			return columns[index]?.align === "right"
				? ` ${padding}${content} `
				: ` ${content}${padding} `;
		});
		const bar = theme.muted("│");
		return `${bar}${rendered.join(bar)}${bar}`;
	};
	return [
		rule("┌", "┬", "┐"),
		line(headers, true),
		...(rows.length > 0 ? [rule("├", "┼", "┤")] : []),
		...rows.map((row) => line(row, false)),
		rule("└", "┴", "┘"),
	].join("\n");
}

/** One labelled record per row, for results too wide for a grid. */
function renderVertical(
	headers: readonly Cell[],
	rows: readonly (readonly Cell[])[],
	width: number
): string {
	const labels = headers.map((header) => `${header.text}:`);
	const labelWidth = Math.max(...labels.map(displayWidth));
	const valueWidth = width - labelWidth - 1;
	return rows
		.map((row, rowIndex) => {
			const title = `Row ${rowIndex + 1}:`;
			const fields = row.map((cell, index) => {
				const label = labels[index] ?? "";
				const text =
					valueWidth >= MIN_COLUMN_WIDTH
						? truncate(cell.text, valueWidth)
						: cell.text;
				const gap = " ".repeat(labelWidth - displayWidth(label) + 1);
				return `${theme.bold(label)}${gap}${styled({ ...cell, text }, false)}`;
			});
			return [
				theme.bold(title),
				theme.muted("─".repeat(title.length)),
				...fields,
			].join("\n");
		})
		.join("\n\n");
}

/**
 * Render rows of raw values, each ordered like `columns`, as a table.
 *
 * Strings print without quotes, other scalars are stringified, and nested
 * values print as compact JSON. Control characters are escaped so data
 * cannot drive the terminal. Right-aligned columns suit numbers.
 */
export function renderTable(
	columns: readonly TableColumn[],
	rows: readonly (readonly unknown[])[],
	options: TableOptions = {}
): string {
	if (columns.length === 0) {
		return "";
	}
	const nullText = options.nullText ?? "";
	const headers = columns.map((column): Cell => ({
		text: escapeTerminalText(column.name),
		muted: false,
	}));
	const cells = rows.map((row) =>
		columns.map((_, index) => formatCell(row[index], nullText))
	);
	const natural = headers.map((header) =>
		Math.max(1, displayWidth(header.text))
	);
	for (const row of cells) {
		for (const [index, cell] of row.entries()) {
			natural[index] = Math.max(natural[index] ?? 1, displayWidth(cell.text));
		}
	}

	if (options.width === undefined) {
		return renderGrid(columns, headers, cells, natural);
	}
	// Leave the last terminal column unused: consoles that wrap as soon as a
	// line reaches the margin (such as the classic Windows console) would
	// otherwise print a blank line after every row.
	const available = options.width - 1 - (3 * columns.length + 1);
	if (sum(natural) <= available) {
		return renderGrid(columns, headers, cells, natural);
	}
	const minimum = natural.map((width) => Math.min(width, MIN_COLUMN_WIDTH));
	if (sum(minimum) > available) {
		return renderVertical(headers, cells, options.width - 1);
	}
	return renderGrid(
		columns,
		headers,
		cells,
		fitWidths(natural, minimum, available)
	);
}
