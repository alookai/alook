import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { buildExecutionPlan, projectPlan, stablePlanJson } from "./changed-scopes.mjs"
import { queryNativeUiFacts } from "./e2e-shards.mjs"
import { runCli, runIfMain, validatePlanEnvelope } from "./validate-execution-plan.mjs"

const plan = buildExecutionPlan(
  [{ status: "M", path: "src/daemon/src/manager.ts" }],
  { baseSha: "a".repeat(40), headSha: "b".repeat(40), nativeUi: queryNativeUiFacts(["all"], { shardCount: 1 }) },
)

describe("execution plan consumer envelope", () => {
  it("validates a real full plan from a file and rejects altered bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-plan-file-"))
    const file = join(directory, "execution-plan.json")
    const body = stablePlanJson(plan)
    expect(Buffer.byteLength(body)).toBeGreaterThan(32_767)
    try {
      writeFileSync(file, body)
      expect(validatePlanEnvelope({ planFile: file, planHash: plan.plan_hash })).toEqual(plan)
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      try {
        runCli({ CI_EXECUTION_PLAN_FILE: file, CI_PLAN_HASH: plan.plan_hash })
        expect(stdout).toHaveBeenCalledWith(expect.stringContaining(plan.plan_hash))
      } finally { stdout.mockRestore() }
      expect(() => validatePlanEnvelope({ planFile: file, planJson: body, planHash: plan.plan_hash })).toThrow("choose one")
      writeFileSync(file, stablePlanJson({ ...plan, head_sha: "c".repeat(40) }))
      expect(() => validatePlanEnvelope({ planFile: file, planHash: plan.plan_hash })).toThrow("hash mismatch")
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it("validates the canonical hash and a mechanical projection", () => {
    expect(validatePlanEnvelope({
      planJson: stablePlanJson(plan),
      planHash: plan.plan_hash,
      projectionName: "integration_suites",
      projectionValue: projectPlan(plan).integration_suites,
    })).toEqual(plan)
  })

  it("rejects stale hashes, unknown projections, and altered selections", () => {
    expect(() => validatePlanEnvelope({})).toThrow("required")
    expect(() => validatePlanEnvelope({
      planJson: stablePlanJson(plan),
      planHash: "0".repeat(64),
    })).toThrow("envelope hash")
    expect(() => validatePlanEnvelope({
      planJson: stablePlanJson(plan),
      planHash: plan.plan_hash,
      projectionName: "future_suite",
      projectionValue: "[]",
    })).toThrow("unknown")
    expect(() => validatePlanEnvelope({
      planJson: stablePlanJson(plan),
      planHash: plan.plan_hash,
      projectionName: "integration_suites",
      projectionValue: "[]",
    })).toThrow("projection mismatch")
  })

  it("runs the environment-backed consumer and reports the validated contract", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const env = {
        CI_EXECUTION_PLAN: stablePlanJson(plan),
        CI_PLAN_HASH: plan.plan_hash,
        CI_PROJECTION_NAME: "integration_suites",
        CI_PROJECTION_VALUE: projectPlan(plan).integration_suites,
      }
      runCli(env)
      runIfMain(
        "file:///tmp/validate-execution-plan.mjs",
        "/tmp/validate-execution-plan.mjs",
        env,
      )

      expect(stdout).toHaveBeenCalledTimes(2)
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining(plan.plan_hash))
    } finally {
      stdout.mockRestore()
    }
  })
})
