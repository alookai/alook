import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare"

vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }))
beforeEach(() => { vi.resetModules(); vi.mocked(initOpenNextCloudflareForDev).mockClear() })
afterEach(() => vi.unstubAllEnvs())

it.each(["configured", "absent"])("executes the actual main Next build config with a %s public telemetry profile", async mode => {
  const profile = mode === "configured" ? { NEXT_PUBLIC_FARO_COLLECTOR_URL: "https://collector.example/collect/public", NEXT_PUBLIC_FARO_ENVIRONMENT: "qa", NEXT_PUBLIC_FARO_RELEASE: "a".repeat(40) } : { NEXT_PUBLIC_FARO_COLLECTOR_URL: undefined, NEXT_PUBLIC_FARO_ENVIRONMENT: undefined, NEXT_PUBLIC_FARO_RELEASE: undefined }
  for (const [key, value] of Object.entries(profile)) vi.stubEnv(key, value)
  const { default: config } = await import("../next.config")
  expect(config.env).toMatchObject(Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, value ?? ""])))
  expect(config.env?.NEXT_PUBLIC_APP_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  expect(config.serverExternalPackages).toContain("@better-auth/core")
  expect(initOpenNextCloudflareForDev).toHaveBeenCalledOnce()
  expect(initOpenNextCloudflareForDev).toHaveBeenCalledWith()
})
