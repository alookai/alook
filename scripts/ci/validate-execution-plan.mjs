import { fileURLToPath } from "node:url"
import { projectPlan, validateExecutionPlan } from "./changed-scopes.mjs"

export function validatePlanEnvelope({ planJson, planHash, projectionName, projectionValue }) {
  if (!planJson) throw new Error("CI execution plan is required")
  const plan = validateExecutionPlan(JSON.parse(planJson))
  if (plan.plan_hash !== planHash) throw new Error("CI execution plan envelope hash mismatch")

  if (projectionName) {
    const projections = projectPlan(plan)
    if (!Object.hasOwn(projections, projectionName)) {
      throw new Error(`unknown CI execution plan projection: ${projectionName}`)
    }
    if (projections[projectionName] !== projectionValue) {
      throw new Error(`CI execution plan projection mismatch: ${projectionName}`)
    }
  }
  return plan
}

export function runCli(env = process.env) {
  const plan = validatePlanEnvelope({
    planJson: env.CI_EXECUTION_PLAN,
    planHash: env.CI_PLAN_HASH,
    projectionName: env.CI_PROJECTION_NAME,
    projectionValue: env.CI_PROJECTION_VALUE,
  })
  process.stdout.write(
    `Validated execution plan ${plan.plan_hash} (schema ${plan.schema_version}, policy ${plan.policy_version}).\n`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli()
