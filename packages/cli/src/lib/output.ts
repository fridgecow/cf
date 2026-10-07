import { Page } from "../sdk/sdk/core/pagination/Page.js";
import { detectAgentContext } from "./agent-context.js";
import { isNonInteractiveOrCI } from "./interactive.js";
import { supportsColor, theme } from "./ui/theme.js";

/** Maximum JSON size (in characters) for syntax highlighting - prevents performance issues */
const MAX_HIGHLIGHTED_JSON_SIZE = 50_000;

export interface OutputPostProcessorContext {
	/** Terminal width in columns, when known. */
	columns: number | undefined;
}

/**
 * Render a command's structured result for a person at a terminal, or
 * return `undefined` to print the default JSON instead.
 */
export type OutputPostProcessor = (
	data: unknown,
	context: OutputPostProcessorContext
) => string | undefined;

export interface OutputOptions {
	quiet?: boolean;
	/** Short human-readable description of the completed action (e.g. "Updated value"). When the API returns null (successful mutation with no payload), printed to stderr as `✓ <successLabel>` on TTYs, silent otherwise. */
	successLabel?: string;
	/**
	 * Human-oriented rendering, used only in interactive terminals outside CI
	 * and agent sessions. Everywhere else the result stays JSON.
	 */
	postProcess?: OutputPostProcessor;
	/** `--json`: print JSON even where `postProcess` would apply. */
	json?: boolean;
}

function outputPayload(data: unknown): unknown {
	if (data instanceof Page) {
		return data.data;
	}

	if (
		data !== null &&
		typeof data === "object" &&
		"result" in data &&
		Array.isArray(data.result) &&
		"result_info" in data
	) {
		return data.result;
	}
	return data;
}

/**
 * Format and output data as JSON.
 *
 * - If options.quiet is true, outputs nothing
 * - If data is null/undefined and options.successLabel is set, prints a ✓
 *   confirmation to stderr on TTYs (and stays silent on stdout so scripts
 *   piping to jq don't see `null`)
 * - With a `postProcess` renderer in an interactive terminal, and without
 *   `--json`, outputs the rendered text (e.g. a table)
 * - Otherwise outputs pretty-printed JSON (highlighted in interactive terminals)
 *
 * Callers who need newline-delimited JSON pipe through `jq -c '.[]'` or
 * similar — cf does not surface an ndjson toggle.
 */
export function formatOutput(data: unknown, options: OutputOptions = {}): void {
	if (options.quiet) {
		return;
	}
	data = outputPayload(data);

	// Null/undefined result: a successful mutation with no interesting body.
	// Stay silent on stdout (scripts piping to jq get an empty stream, not
	// the literal string 'null'), and — on TTYs only — write a brief ✓
	// line to stderr so humans know it worked.
	if (data === null || data === undefined) {
		if (options.successLabel && process.stderr.isTTY) {
			process.stderr.write(`${theme.success("✓")} ${options.successLabel}\n`);
		}
		return;
	}

	const rendered = postProcessOutput(data, options);
	console.log(rendered ?? formatJson(data));
}

/**
 * Post-processed output is only for people. Pipes, CI logs, and agents —
 * which may drive a pseudo-terminal — keep the stable JSON contract.
 */
function postProcessOutput(
	data: unknown,
	options: OutputOptions
): string | undefined {
	if (
		options.postProcess === undefined ||
		options.json === true ||
		isNonInteractiveOrCI() ||
		detectAgentContext().isAgentic
	) {
		return undefined;
	}
	try {
		return options.postProcess(data, { columns: process.stdout.columns });
	} catch {
		// The request already succeeded; a rendering bug must not lose its
		// result, so fall back to JSON.
		return undefined;
	}
}

/**
 * Format JSON with syntax highlighting.
 * JSON values use semantic theme roles. Skips highlighting for large outputs
 * to prevent performance issues.
 */
function formatJson(data: unknown): string {
	const json = JSON.stringify(data, null, 2);

	// Non-interactive output must remain parseable even when FORCE_COLOR is set.
	if (
		isNonInteractiveOrCI() ||
		!supportsColor() ||
		json.length > MAX_HIGHLIGHTED_JSON_SIZE
	) {
		return json;
	}

	return json
		.replace(
			// Match a quoted key followed by a colon, consuming escapes as pairs
			// so escaped quotes inside a value cannot be mistaken for key delimiters.
			/"((?:[^"\\]|\\.)*)":/g,
			(_match, key) => `${theme.jsonKey(`"${key}"`)}:`
		)
		.replace(
			// Match a quoted value after a colon, consuming escapes as pairs
			// so only an unescaped quote can end the string.
			/: "((?:[^"\\]|\\.)*)"/g,
			(_match, value) => `: ${theme.jsonString(`"${value}"`)}`
		)
		.replace(/: (-?\d+\.?\d*)/g, (_match, num) => `: ${theme.jsonNumber(num)}`)
		.replace(
			/: (true|false)/g,
			(_match, bool) => `: ${theme.jsonBoolean(bool)}`
		)
		.replace(/: (null)/g, (_match, n) => `: ${theme.muted(n)}`);
}
