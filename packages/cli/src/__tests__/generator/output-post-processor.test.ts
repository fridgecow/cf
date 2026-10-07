import { describe, expect, it } from "vite-plus/test";
import { buildEmitContext } from "../../../generator/emit/build-context.js";
import { buildImportSet } from "../../../generator/emit/handler/imports.js";
import { emitHandler } from "../../../generator/emit/handler/index.js";
import {
	handWrittenOutputPostProcessorModule,
	outputPostProcessorErrors,
} from "../../../generator/hand-written-overrides.js";
import type { OperationInfo, Schema } from "@cloudflare/forge";

const MODULE = "#commands/example/query/output.js";

function queryOperation(
	overrides: Record<string, unknown> = {}
): OperationInfo {
	return {
		path: "/accounts/{account_id}/example/query",
		method: "post",
		description: "Run a query",
		pathParams: [{ name: "account_id", required: true, type: "string" }],
		queryParams: [],
		headerParams: [],
		bodyParams: [
			{
				name: "query",
				type: "string",
				required: true,
				apiFieldPath: ["query"],
			},
		],
		hasRequestBody: true,
		requestContentTypes: ["application/json"],
		requestBodyRef: null,
		requestBodyRequired: ["query"],
		requestBodyIsArray: false,
		requestBodyArrayItemRef: null,
		responses: {
			"200": {
				content: { "application/json": { schema: { type: "object" } } },
			},
		},
		...overrides,
	} as unknown as OperationInfo;
}

function emit(opInfo: OperationInfo, outputPostProcessorModule?: string) {
	const { ctx } = buildEmitContext({
		method: {
			name: "query",
			operationId: "example-query",
			description: "Run a query",
		} as Schema.method,
		resourceName: "example",
		groupName: undefined,
		opInfo,
		outputPostProcessorModule,
	});
	return {
		handler: emitHandler(ctx).join("\n"),
		imports: buildImportSet(ctx).render(),
	};
}

describe("output post-processor emission", () => {
	it("passes the registered renderer and --json to every formatOutput call", () => {
		const { handler, imports } = emit(queryOperation(), MODULE);

		const calls = handler.match(/formatOutput\(.*\);/g) ?? [];
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call).toMatch(
				/^formatOutput\(result, \{ successLabel: `[^`]+`, json: argv\.json, postProcess: outputPostProcessor \}\);$/
			);
		}
		expect(imports).toContain(
			`import { outputPostProcessor } from '${MODULE}';`
		);
	});

	it("leaves unregistered leaves on plain JSON output", () => {
		const { handler, imports } = emit(queryOperation());

		expect(handler).toContain("formatOutput(result, { successLabel:");
		expect(handler).not.toContain("postProcess");
		expect(imports.join("\n")).not.toContain("outputPostProcessor");
	});

	it("rejects a renderer for an operation without a JSON response", () => {
		expect(() =>
			emit(
				queryOperation({
					responses: {
						"200": {
							content: { "text/plain": { schema: { type: "string" } } },
						},
					},
				}),
				MODULE
			)
		).toThrow(
			'Output post-processor for operation "example-query" needs a JSON response, but the operation writes text output.'
		);
	});

	it("rejects a renderer for an operation with its own json argument", () => {
		expect(() =>
			emit(
				queryOperation({
					queryParams: [{ name: "json", required: false, type: "boolean" }],
				}),
				MODULE
			)
		).toThrow(
			'Output post-processor for operation "example-query" needs the global --json flag, but the operation defines its own json argument.'
		);
	});
});

describe("output post-processor registry", () => {
	const entry = {
		kind: "outputPostProcessor",
		operationId: "example-query",
		dir: "example/query",
	} as const;
	const label = 'Output post-processor for operation "example-query"';
	const missingModule = `${label} is missing src/commands/example/query/output.ts.`;

	it("resolves registered operations to their output module", () => {
		expect(handWrittenOutputPostProcessorModule("example-query", [entry])).toBe(
			MODULE
		);
		expect(
			handWrittenOutputPostProcessorModule("zones-get", [entry])
		).toBeUndefined();
		expect(
			handWrittenOutputPostProcessorModule(undefined, [entry])
		).toBeUndefined();
	});

	it("fails generation when a registration has no module or generated command", () => {
		expect(
			outputPostProcessorErrors([{ operationId: "zones-get" }], [entry])
		).toEqual([missingModule, `${label} did not match a generated command.`]);
	});

	it("fails generation when an operation is registered twice", () => {
		expect(
			outputPostProcessorErrors(
				[{ operationId: "example-query" }],
				[entry, entry]
			)
		).toEqual([
			missingModule,
			`${label} is registered more than once.`,
			missingModule,
		]);
	});
});
