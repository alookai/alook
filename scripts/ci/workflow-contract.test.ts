import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflowRoot = resolve(import.meta.dirname, "../../.github/workflows")
const workflow = readFileSync(resolve(workflowRoot, "e2e-ui.yml"), "utf8")
const ciWorkflow = readFileSync(resolve(workflowRoot, "ci.yml"), "utf8")
const publishWorkflows = ["publish-app.yml", "publish-cli.yml", "publish-daemon.yml"]
  .map((name) => readFileSync(resolve(workflowRoot, name), "utf8"))

function ciJob(name: string): string {
  const start = ciWorkflow.indexOf(`\n  ${name}:\n`)
  if (start < 0) throw new Error(`missing CI job: ${name}`)
  const next = ciWorkflow.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/)
  return next < 0 ? ciWorkflow.slice(start) : ciWorkflow.slice(start, start + 1 + next)
}

describe("E2E UI workflow", () => {
  it("runs before merge without running on main pushes", () => {
    expect(workflow).toMatch(/^  pull_request:/m)
    expect(workflow).toMatch(/^  merge_group:/m)
    expect(workflow).not.toMatch(/^  push:/m)
  })

  it("uploads service logs when a Playwright shard fails", () => {
    expect(workflow).toContain("src/web/e2e-service-logs/")
  })

  it("does not install Bun for Node-only browser tests", () => {
    expect(workflow).not.toContain("oven-sh/setup-bun")
  })
})

describe("Bun workflow setup", () => {
  it("installs pinned Bun in every CI job that builds a daemon package fixture", () => {
    const bunJobs = ["test-linux", "test-windows", "build", "coverage"]
    expect(ciWorkflow.match(/oven-sh\/setup-bun/g)).toHaveLength(bunJobs.length)
    for (const job of bunJobs) {
      expect(ciJob(job)).toContain("oven-sh/setup-bun")
      expect(ciJob(job)).toContain("bun-version: 1.3.11")
    }
    for (const publishWorkflow of publishWorkflows) {
      expect(publishWorkflow).toContain("oven-sh/setup-bun")
      expect(publishWorkflow).toContain("bun-version: 1.3.11")
    }
  })
})
