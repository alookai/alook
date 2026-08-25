import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { RATE_LIMITS } from "../../../../shared/src/lib/rate-limits"

describe("link preview Worker network boundary", () => {
  it("deploys global fetch through the public Internet boundary", () => {
    const wranglerPath = fileURLToPath(new URL("../../../wrangler.toml", import.meta.url))
    const config = readFileSync(wranglerPath, "utf8")
    const flags = config.match(/^compatibility_flags\s*=\s*\[([^\]]+)\]/m)?.[1] ?? ""

    expect(flags).toContain('"nodejs_compat"')
    expect(flags).toContain('"global_fetch_strictly_public"')
    expect(config).toMatch(/^\[images\]\nbinding\s*=\s*"IMAGES"$/m)
    expect(RATE_LIMITS["community:linkPreviewThumbnail"]).toEqual({
      windowMs: 60_000,
      max: 120,
    })
  })

  it("fails every Web production artifact path closed on the R2 lifecycle preflight", () => {
    const webPackagePath = fileURLToPath(new URL("../../../package.json", import.meta.url))
    const rootPackagePath = fileURLToPath(new URL("../../../../../package.json", import.meta.url))
    const webPackage = JSON.parse(readFileSync(webPackagePath, "utf8")) as {
      scripts: Record<string, string>
    }
    const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as {
      scripts: Record<string, string>
    }

    expect(webPackage.scripts.deploy).toMatch(/^pnpm preflight:link-preview-thumbnails && /)
    expect(webPackage.scripts.upload).toMatch(/^pnpm preflight:link-preview-thumbnails && /)
    expect(rootPackage.scripts["deploy:web"])
      .toMatch(/^pnpm --filter @alook\/web preflight:link-preview-thumbnails && /)
  })
})
