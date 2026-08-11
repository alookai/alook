import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const script = fileURLToPath(new URL("./assert-gate.mjs", import.meta.url))

function run(checks: unknown) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, CI_GATE_RESULTS: JSON.stringify(checks) },
  })
}

describe("assert-gate", () => {
  it("accepts successful required jobs and skipped out-of-scope jobs", () => {
    const result = run([
      { name: "quality", expected: true, result: "success" },
      { name: "rust", expected: false, result: "skipped" },
    ])

    expect(result.status).toBe(0)
  })

  it("rejects failed, cancelled, and unexpectedly skipped required jobs", () => {
    for (const status of ["failure", "cancelled", "skipped"]) {
      const result = run([{ name: "quality", expected: true, result: status }])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`received ${status}`)
    }
  })

  it("rejects an unexpected out-of-scope execution", () => {
    const result = run([{ name: "rust", expected: false, result: "success" }])

    expect(result.status).toBe(1)
  })
})
