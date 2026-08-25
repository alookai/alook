import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("link preview Worker network boundary", () => {
  it("deploys global fetch through the public Internet boundary", () => {
    const wranglerPath = fileURLToPath(new URL("../../../wrangler.toml", import.meta.url))
    const config = readFileSync(wranglerPath, "utf8")
    const flags = config.match(/^compatibility_flags\s*=\s*\[([^\]]+)\]/m)?.[1] ?? ""

    expect(flags).toContain('"nodejs_compat"')
    expect(flags).toContain('"global_fetch_strictly_public"')
  })
})
