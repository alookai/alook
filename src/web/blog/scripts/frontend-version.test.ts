import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"

vi.mock("@next/mdx", () => ({ default: () => (config: unknown) => config }))
vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }))

it("injects the same shared frontend package version into the Blog build", async () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"))
  const { default: config } = await import("../next.config")
  expect(config.env?.NEXT_PUBLIC_APP_VERSION).toBe(pkg.version)
  expect(config.assetPrefix).toBe("/blog-static")
})
