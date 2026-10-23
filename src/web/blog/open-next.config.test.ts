import { describe, expect, it } from "vitest";
import config from "./open-next.config";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

describe("Blog OpenNext configuration", () => {
	it("builds the nested app without mutable cache bindings", async () => {
		expect(config.appPath).toBe("blog");
		expect(config.buildOutputPath).toBe("blog");
		expect(config.packageJsonPath).toBe("blog");
		expect(config.buildCommand).toBe("pnpm --dir .. build:blog:next");
		expect(config.dangerous?.disableIncrementalCache).not.toBe(true);
		expect(config.dangerous?.enableCacheInterception).toBe(true);
		expect(config.dangerous?.disableTagCache).toBe(true);
		expect(config.cloudflare?.dangerousDisableConfigValidation).not.toBe(true);
		const serverCache = config.default.override?.incrementalCache;
		if (typeof serverCache !== "function") throw new Error("Static cache loader is missing");
		expect(await serverCache()).toBe(staticAssetsIncrementalCache);
		expect(config.default.override?.tagCache).toBe("dummy");
		expect(config.default.override?.queue).toBe("direct");
		const middlewareCache = config.middleware?.override?.incrementalCache;
		if (typeof middlewareCache !== "function") throw new Error("Static middleware cache loader is missing");
		expect(await middlewareCache()).toBe(staticAssetsIncrementalCache);
		expect(config.middleware?.override?.tagCache).toBe("dummy");
		expect(config.middleware?.override?.queue).toBe("direct");
	});
});
