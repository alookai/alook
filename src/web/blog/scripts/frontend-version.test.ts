import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("@next/mdx", () => ({ default: () => (config: unknown) => config }))
vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }))

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

function loadBuildConfigs(mode: string) {
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
      console.log("FRONTEND_BUILD_CONFIG=" + JSON.stringify(configs));
      process.exit(0);
    })().catch(error => { console.error(error); process.exit(1); });
  `], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: mode },
  })
  const encoded = output.split("\n").find(line => line.startsWith("FRONTEND_BUILD_CONFIG="))!
  return JSON.parse(encoded.slice("FRONTEND_BUILD_CONFIG=".length)) as Array<{ env: Record<string, string>; assetPrefix?: string }>
}

it("injects the same shared frontend package version into the Blog build", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"))
  const [webConfig, blogConfig] = loadBuildConfigs("production")
  expect(webConfig.env?.NEXT_PUBLIC_APP_VERSION).toBe(pkg.version)
  expect(blogConfig.env?.NEXT_PUBLIC_APP_VERSION).toBe(pkg.version)
  expect(blogConfig.assetPrefix).toBe("/blog-static")
  expect(webConfig.env).not.toHaveProperty("NEXT_PUBLIC_FARO_RELEASE")
  expect(blogConfig.env).not.toHaveProperty("NEXT_PUBLIC_FARO_RELEASE")
})

it("executes the real Blog configuration with the shared package version", async () => {
  vi.stubEnv("NODE_ENV", "production")
  const { default: loadConfig } = await import("../next.config")
  const config = await loadConfig()
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"))
  expect(config.env).toMatchObject({ NEXT_PUBLIC_APP_VERSION: pkg.version })
  expect(config.env).not.toHaveProperty("NEXT_PUBLIC_FARO_RELEASE")
  expect(config.assetPrefix).toBe("/blog-static")
})
