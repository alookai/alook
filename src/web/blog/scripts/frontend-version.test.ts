import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

function loadBuildConfigs(mode: string, source: string) {
  const output = execFileSync(process.execPath, ["-e", `
    const path = require("node:path");
    const { transpileConfig } = require("next/dist/build/next-config-ts/transpile-config");
    (async () => {
      const configs = [];
      for (const app of [".", "blog"]) {
        const dir = path.resolve(app);
        const loaded = await transpileConfig({ nextConfigPath: path.join(dir, "next.config.ts"), dir });
        const config = typeof loaded.default === "function" ? await loaded.default() : loaded.default;
        configs.push({ env: config.env, assetPrefix: config.assetPrefix });
      }
      console.log("FARO_BUILD_CONFIG=" + JSON.stringify(configs));
      process.exit(0);
    })().catch(error => { console.error(error); process.exit(1); });
  `], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: mode, WORKERS_CI_COMMIT_SHA: source, CF_PAGES_COMMIT_SHA: "", GITHUB_SHA: "",
      NEXT_PUBLIC_FARO_RELEASE: "c".repeat(40), NEXT_PUBLIC_FARO_ENVIRONMENT: "qa" },
  })
  const encoded = output.split("\n").find(line => line.startsWith("FARO_BUILD_CONFIG="))!
  return JSON.parse(encoded.slice("FARO_BUILD_CONFIG=".length)) as Array<{ env: Record<string, string>; assetPrefix?: string }>
}

it("injects the same shared frontend package version into the Blog build", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"))
  const config = loadBuildConfigs("production", "")[1]
  expect(config.env?.NEXT_PUBLIC_APP_VERSION).toBe(pkg.version)
  expect(config.assetPrefix).toBe("/blog-static")
})

it.each([
  { mode: "production", source: "a".repeat(40), release: "a".repeat(40), environment: "production" },
  { mode: "development", source: "b".repeat(40), release: "b".repeat(40), environment: "development" },
  { mode: "production", source: "", release: "", environment: "production" },
  { mode: "test", source: "", release: "", environment: "" },
])("embeds native provenance in both apps for $mode with source '$source'", ({ mode, source, release, environment }) => {
  for (const config of loadBuildConfigs(mode, source)) {
    expect(config.env).toMatchObject({ NEXT_PUBLIC_FARO_RELEASE: release, NEXT_PUBLIC_FARO_ENVIRONMENT: environment })
  }
})
