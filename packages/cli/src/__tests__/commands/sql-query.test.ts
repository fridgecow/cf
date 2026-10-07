import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { runInTempDir } from "@cloudflare/workers-utils/test-helpers";
import { http, HttpResponse } from "msw";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { outputPostProcessorHandWrittenCommands } from "../../commands/hand-written.js";
import { buildCli } from "../../index.js";
import { captureOutput } from "../helpers/capture-output.js";
import { server, setupMsw, TEST_BASE_URL } from "../helpers/msw.js";
import { runCf } from "../helpers/run-cf.js";
import type { CommandMeta } from "@cloudflare/forge";

const ciInfo = vi.hoisted(() => ({ isCI: false }));
vi.mock("ci-info", () => ({ default: ciInfo }));

const agentDetection = vi.hoisted(() => ({ isAgentic: false }));
vi.mock("../../lib/agent-context.js", () => ({
	detectAgentContext: () => ({
		isAgentic: agentDetection.isAgentic,
		harness: null,
		model: null,
		sessionId: null,
		invocationId: null,
		matches: [],
	}),
}));

const OPERATION_ID = "sql-api-query-post";

const commands = (
	JSON.parse(
		readFileSync(
			new URL("../../commands/_generated/_meta/commands.json", import.meta.url),
			"utf-8"
		)
	) as { commands: CommandMeta[] }
).commands;

/** `cf sql query`, found by operationId so these tests follow Forge renames. */
const sqlCommand = commands.find(
	(command) => command.operationId === OPERATION_ID
);

/**
 * Drift guard: the SQL table view is registered against an operationId,
 * outside the spec. If the operation is renamed or removed, generation
 * fails; these assertions pin down the rest of what the view relies on.
 */
describe("SQL query output post-processor — drift guard", () => {
	it("is the only registered output post-processor", () => {
		expect(outputPostProcessorHandWrittenCommands()).toEqual([
			{
				kind: "outputPostProcessor",
				operationId: OPERATION_ID,
				dir: "sql/query",
			},
		]);
	});

	it("still targets a generated SQL query command that renders through it", () => {
		expect(sqlCommand?.httpMethod).toBe("POST");
		expect(sqlCommand?.apiPath).toBe("/analytics/sql");

		const source = readFileSync(
			new URL(
				`../../commands/_generated/${sqlCommand?.fullPath.join("/")}.ts`,
				import.meta.url
			),
			"utf-8"
		);
		expect(source).toContain(
			'import { outputPostProcessor } from "#commands/sql/query/output.js";'
		);
		expect(source).toContain("postProcess: outputPostProcessor");
	});
});

describe("SQL query output (network)", () => {
	runInTempDir();
	setupMsw();

	const ENV = {
		CLOUDFLARE_API_TOKEN: "test-token",
		CLOUDFLARE_API_BASE_URL: TEST_BASE_URL,
		// Keeps the progress spinner from animating on the simulated terminal.
		NO_COLOR: "1",
	};
	const response = {
		data: [{ count: 2, label: "bar" }],
		rows: 1,
		statistics: { elapsed_ms: 5, rows_read: 10, bytes_read: 2_048 },
	};
	const original = {
		stdin: process.stdin.isTTY,
		stdout: process.stdout.isTTY,
		columns: process.stdout.columns,
	};
	let output: ReturnType<typeof captureOutput>;

	function setTTY(
		stream: NodeJS.ReadStream | NodeJS.WriteStream,
		value: boolean | undefined
	): void {
		Object.defineProperty(stream, "isTTY", { value, configurable: true });
	}

	function interactiveTerminal(): void {
		setTTY(process.stdin, true);
		setTTY(process.stdout, true);
		process.stdout.columns = 100;
	}

	function queryArgs(query: string): string[] {
		if (sqlCommand === undefined) {
			throw new Error(`No generated command for ${OPERATION_ID}`);
		}
		const positional = sqlCommand.arguments.some(
			(argument) => argument.name === "query"
		);
		return [
			...sqlCommand.fullPath,
			...(positional ? [query] : ["--query", query]),
		];
	}

	beforeEach(() => {
		output = captureOutput();
		ciInfo.isCI = false;
		agentDetection.isAgentic = false;
		server.use(
			http.post(`${TEST_BASE_URL}/analytics/sql`, () =>
				HttpResponse.json(response)
			)
		);
	});

	afterEach(() => {
		setTTY(process.stdin, original.stdin);
		setTTY(process.stdout, original.stdout);
		process.stdout.columns = original.columns;
		vi.restoreAllMocks();
	});

	it("prints a table in an interactive terminal", async () => {
		interactiveTerminal();

		const { exitCode } = await runCf(
			queryArgs("SELECT label, count() AS count FROM t"),
			ENV
		);

		expect(exitCode).toBe(0);
		expect(stripVTControlCharacters(output.stdout())).toBe(
			[
				"┌───────┬───────┐",
				"│ count │ label │",
				"├───────┼───────┤",
				"│     2 │ bar   │",
				"└───────┴───────┘",
				"",
				"1 row in set. Elapsed: 5 ms. Read 10 rows, 2.05 KB.",
			].join("\n")
		);
	});

	it("prints JSON in an interactive terminal with --json", async () => {
		interactiveTerminal();

		await runCf([...queryArgs("SELECT 1"), "--json"], ENV);

		expect(JSON.parse(stripVTControlCharacters(output.stdout()))).toEqual(
			response
		);
	});

	it("prints JSON when stdout is not a terminal", async () => {
		setTTY(process.stdout, false);

		await runCf(queryArgs("SELECT 1"), ENV);

		expect(JSON.parse(output.stdout())).toEqual(response);
	});

	it("prints JSON for agents in an interactive terminal", async () => {
		interactiveTerminal();
		agentDetection.isAgentic = true;

		await runCf(queryArgs("SELECT 1"), ENV);

		expect(JSON.parse(stripVTControlCharacters(output.stdout()))).toEqual(
			response
		);
	});

	it("prints text formats as received in an interactive terminal", async () => {
		interactiveTerminal();
		server.use(
			http.post(
				`${TEST_BASE_URL}/analytics/sql`,
				() =>
					new HttpResponse("bar\t2\n", {
						headers: { "Content-Type": "text/tab-separated-values" },
					})
			)
		);

		await runCf(queryArgs("SELECT label, count() FROM t FORMAT TSV"), ENV);

		expect(output.stdout()).toBe("bar\t2");
	});

	it("lists --json among the global flags in help", async () => {
		const help = await buildCli([
			...(sqlCommand?.fullPath ?? []),
			"--help",
		]).cli.getHelp();

		expect(help).toContain("--json");
		expect(help).toContain("Print results as JSON instead of tables");
	});
});
