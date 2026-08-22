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
})
