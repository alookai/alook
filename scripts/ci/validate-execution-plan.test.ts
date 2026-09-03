import { describe, expect, it } from "vitest"
import { buildExecutionPlan, projectPlan, stablePlanJson } from "./changed-scopes.mjs"
import { validatePlanEnvelope } from "./validate-execution-plan.mjs"

const plan = buildExecutionPlan(
  [{ status: "M", path: "src/cli/src/commands/inbox.ts" }],
  { baseSha: "a".repeat(40), headSha: "b".repeat(40) },
)

describe("execution plan consumer envelope", () => {
  it("validates the canonical hash and a mechanical projection", () => {
    expect(validatePlanEnvelope({
      planJson: stablePlanJson(plan),
      planHash: plan.plan_hash,
      projectionName: "integration_suites",
      projectionValue: projectPlan(plan).integration_suites,
    })).toEqual(plan)
  })

  it("rejects stale hashes, unknown projections, and altered selections", () => {
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
})
