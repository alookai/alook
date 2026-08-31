import { describe, expect, it } from "vitest";
import config from "./open-next.config";

describe("Blog OpenNext configuration", () => {
	it("builds the nested app without mutable cache bindings", () => {
		expect(config.appPath).toBe("blog");
		expect(config.buildOutputPath).toBe("blog");
		expect(config.packageJsonPath).toBe("blog");
		expect(config.buildCommand).toBe("pnpm --dir .. build:blog:next");
		expect(config.dangerous?.disableIncrementalCache).toBe(true);
		expect(config.dangerous?.disableTagCache).toBe(true);
		expect(config.cloudflare?.dangerousDisableConfigValidation).not.toBe(true);
		expect(config.default.override?.incrementalCache).toBe("dummy");
		expect(config.default.override?.tagCache).toBe("dummy");
		expect(config.default.override?.queue).toBe("direct");
		expect(config.middleware?.override?.incrementalCache).toBe("dummy");
		expect(config.middleware?.override?.tagCache).toBe("dummy");
		expect(config.middleware?.override?.queue).toBe("direct");
	});
});
