import { afterEach, describe, expect, it, vi } from "vitest"

const originalCi = process.env.CI

async function loadReporter(ci: string | undefined) {
  if (ci === undefined) {
    delete process.env.CI
  } else {
    process.env.CI = ci
  }

  vi.resetModules()
  const { default: config } = await import("../../playwright.config")
  return config.reporter
}

async function loadConfig() {
  vi.resetModules()
  return (await import("../../playwright.config")).default
}

afterEach(() => {
  if (originalCi === undefined) {
    delete process.env.CI
  } else {
    process.env.CI = originalCi
  }
  vi.resetModules()
})

describe("Playwright reporter configuration", () => {
  it("publishes blob, GitHub, and list reporters in CI", async () => {
    await expect(loadReporter("1")).resolves.toEqual([
      ["blob"],
      ["github"],
      ["list"],
    ])
  })

  it("uses the list reporter outside CI", async () => {
    await expect(loadReporter(undefined)).resolves.toBe("list")
  })

  it("keeps the single-worker zero-retry timing contract without a global failure cap", async () => {
    const config = await loadConfig()
    expect(config.retries).toBe(0)
    expect(config.workers).toBe(1)
    expect(config.timeout).toBe(60_000)
    expect(config.expect?.timeout).toBe(10_000)
    expect(config.maxFailures).toBeUndefined()
  })
})
