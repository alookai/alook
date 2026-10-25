import path from "node:path"
import { describe, expect, it } from "vitest"
import config from "./next.config"

describe("standalone App Store capture configuration", () => {
  it("resolves shared workspace imports without generating app-owned instruction files", () => {
    expect(config.turbopack?.root).toBe(path.resolve(import.meta.dirname, "../../.."))
    expect(config.agentRules).toBe(false)
  })
})
