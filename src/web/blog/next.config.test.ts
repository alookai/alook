import path from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare"

vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }))
beforeEach(() => { vi.resetModules(); vi.mocked(initOpenNextCloudflareForDev).mockClear() })
afterEach(() => vi.unstubAllEnvs())

it.each(["configured", "absent"])("executes the independently wrapped Blog config with a %s public telemetry profile", async mode => {
  const profile = mode === "configured" ? { NEXT_PUBLIC_FARO_COLLECTOR_URL: "https://collector.example/collect/blog-public", NEXT_PUBLIC_FARO_ENVIRONMENT: "qa", NEXT_PUBLIC_FARO_RELEASE: "b".repeat(40) } : { NEXT_PUBLIC_FARO_COLLECTOR_URL: undefined, NEXT_PUBLIC_FARO_ENVIRONMENT: undefined, NEXT_PUBLIC_FARO_RELEASE: undefined }
  for (const [key, value] of Object.entries(profile)) vi.stubEnv(key, value)
  const { default: config } = await import("./next.config")
  expect(config.env).toMatchObject(Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, value ?? ""])))
  expect(config.assetPrefix).toBe("/blog-static")
  expect(config.pageExtensions).toContain("mdx")
  expect(config.images?.unoptimized).toBe(true)
  expect(config.webpack).toBeTypeOf("function")
  const redirects = await config.redirects!()
  expect(redirects.length).toBeGreaterThan(0)
  expect(redirects).toContainEqual(expect.objectContaining({ statusCode: 301 }))
  expect(initOpenNextCloudflareForDev).toHaveBeenCalledWith({ configPath: path.resolve(__dirname, "wrangler.toml") })
})
