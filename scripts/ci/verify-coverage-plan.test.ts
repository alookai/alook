import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { buildExecutionPlan } from "./changed-scopes.mjs"
import { verifyCoveragePlan } from "./verify-coverage-plan.mjs"

const baseSha = "a".repeat(40)
const headSha = "b".repeat(40)

function coveredFile(path: string, covered = true) {
  return {
    path,
    statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
    s: { "0": covered ? 1 : 0 },
    fnMap: {},
    f: {},
    branchMap: {},
    b: {},
  }
}

describe("verifyCoveragePlan", () => {
  it("proves required changed files and a nonempty passing Codecov project denominator", () => {
    const changed = "src/cli/commands/update.ts"
    const plan = buildExecutionPlan([{ status: "M", path: changed }], { baseSha, headSha })
    const report = {
      [resolve(changed)]: coveredFile(resolve(changed)),
      [resolve("src/cli/lib/config.ts")]: coveredFile(resolve("src/cli/lib/config.ts")),
    }

    const result = verifyCoveragePlan(plan, report)

    expect(result.required_changed_files).toEqual([changed])
    expect(result.targets.cli).toMatchObject({ files: 2, statements: 2, covered: 2, percent: 100 })
  })

  it("rejects a required surviving changed file missing from the merged report", () => {
    const changed = "src/cli/commands/update.ts"
    const plan = buildExecutionPlan([{ status: "M", path: changed }], { baseSha, headSha })

    expect(() => verifyCoveragePlan(plan, {
      [resolve("src/cli/lib/config.ts")]: coveredFile(resolve("src/cli/lib/config.ts")),
    })).toThrow("required changed coverage file")
  })

  it("rejects empty and below-target Codecov project reports", () => {
    const changed = "src/shared/src/semver.ts"
    const plan = buildExecutionPlan([{ status: "M", path: changed }], { baseSha, headSha })
    const testOnlyPlan = buildExecutionPlan(
      [{ status: "M", path: "src/shared/src/logger.test.ts" }],
      { baseSha, headSha },
    )

    expect(() => verifyCoveragePlan(testOnlyPlan, {})).toThrow("nonempty denominator")
    expect(() => verifyCoveragePlan(plan, {
      [resolve("src/cli/lib/config.ts")]: coveredFile(resolve("src/cli/lib/config.ts")),
      [resolve("src/email-worker/src/index.ts")]: coveredFile(resolve("src/email-worker/src/index.ts")),
      [resolve(changed)]: coveredFile(resolve(changed), false),
      [resolve("src/web/src/lib/config.ts")]: coveredFile(resolve("src/web/src/lib/config.ts")),
      [resolve("src/ws-do/src/index.ts")]: coveredFile(resolve("src/ws-do/src/index.ts")),
    })).toThrow("project target shared")
  })

  it("writes an auditable target manifest from the CLI", async () => {
    const changed = "src/cli/commands/update.ts"
    const plan = buildExecutionPlan([{ status: "M", path: changed }], { baseSha, headSha })
    const directory = mkdtempSync(join(tmpdir(), "alook-coverage-plan-"))
    const planPath = join(directory, "plan.json")
    const reportPath = join(directory, "coverage.json")
    const outputPath = join(directory, "manifest.json")
    try {
      writeFileSync(planPath, JSON.stringify(plan))
      writeFileSync(reportPath, JSON.stringify({
        [resolve(changed)]: coveredFile(resolve(changed)),
      }))
      const { runCli } = await import("./verify-coverage-plan.mjs")
      runCli(["--plan", planPath, "--report", reportPath, "--output", outputPath])
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
        plan_hash: plan.plan_hash,
        required_changed_files: [changed],
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
