import { runInTempDir } from "@cloudflare/workers-utils/test-helpers";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { captureOutput } from "./helpers/capture-output.js";
import { runCf } from "./helpers/run-cf.js";

describe("--json global flag", () => {
	runInTempDir();

	let output: ReturnType<typeof captureOutput>;

	beforeEach(() => {
		output = captureOutput();
	});

	afterEach(() => vi.restoreAllMocks());

	it("appears in root help", async () => {
		await runCf(["--help"]);

		expect(output.stdout()).toContain("--json");
	});

	it("is accepted by commands without a table view", async () => {
		const { exitCode } = await runCf(["d1", "list", "--json", "--dry-run"], {
			CLOUDFLARE_ACCOUNT_ID: "account-id",
			CI: "true",
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(output.stdout())).toMatchObject({ method: "GET" });
	});
});
