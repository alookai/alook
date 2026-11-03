import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import config from "./open-next.config";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

describe("Blog OpenNext configuration", () => {
	it("builds the nested app without mutable cache bindings", async () => {
        const web = resolve(import.meta.dirname, "..");
        const fromWeb = createRequire(resolve(web, "package.json"));
        const fromCloudflare = createRequire(fromWeb.resolve("@opennextjs/cloudflare"));
        const helper = pathToFileURL(fromCloudflare.resolve("@opennextjs/aws/build/helper.js")).href;
        const selected = { appPath: config.appPath, buildOutputPath: config.buildOutputPath, packageJsonPath: config.packageJsonPath };
        const script = `import { normalizeOptions } from ${JSON.stringify(helper)}; const result = normalizeOptions(${JSON.stringify(selected)}, ".", "."); console.log(JSON.stringify({ app: result.appPath, output: result.appBuildOutputPath, package: result.appPackageJsonPath }));`;
        const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: web, encoding: "utf8" });
        const resolved = JSON.parse(output.trim().split("\n").at(-1)!);
        expect(relative(web, resolved.app)).toBe("blog");
        expect(relative(web, resolved.output)).toBe("blog");
        expect(relative(web, resolved.package)).toBe("package.json");
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
