import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/e2e-ui.yml"), "utf8")

describe("E2E UI workflow", () => {
  it("runs before merge without running on main pushes", () => {
    expect(workflow).toMatch(/^  pull_request:/m)
    expect(workflow).toMatch(/^  merge_group:/m)
    expect(workflow).not.toMatch(/^  push:/m)
  })

  it("uploads service logs when a Playwright shard fails", () => {
    expect(workflow).toContain("src/web/e2e-service-logs/")
  })
})
