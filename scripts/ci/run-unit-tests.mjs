import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createVitest } from "vitest/node"
import { loadScopeManifest, validateExecutionPlan } from "./changed-scopes.mjs"
import { validatePlanEnvelope } from "./validate-execution-plan.mjs"

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))
export const CI_DEDICATED_TEST_FILES = [
  "src/daemon/agent-driver/src/pack.test.ts",
  "src/daemon/src/cli/daemonLifecycle.real.test.ts",
  "src/daemon/src/cli/diagnosticsLifecycle.real.test.ts",
  "src/daemon/src/cli/daemonStop.test.ts",
  "src/daemon/src/version.packed.test.ts",
  "src/daemon/src/agent-driver-bundle.packed.test.ts",
  "src/daemon/src/cli/daemonSelfUpdate.real.test.ts",
]
const dedicatedFiles = new Set(CI_DEDICATED_TEST_FILES.map(file => resolve(ROOT, file)))

export function unitProjects(plan, manifest = loadScopeManifest()) {
  if (plan.suites.smoke.length) return { projects: undefined, fullProjects: [], smoke: plan.suites.smoke }
  const tasks = plan.full
    ? Object.keys(manifest.unit_tasks)
    : plan.suites.unit_tasks
  const projects = new Set(plan.full ? ["ci-scripts"] : [])
  const fullProjects = new Set(plan.full ? ["ci-scripts"] : [])
  for (const task of tasks) {
    const entry = manifest.unit_tasks[task]
    if (!entry) throw new Error("unit task has no execution project: " + task)
    for (const project of entry.projects) {
      projects.add(project)
      if (entry.selection === "project") fullProjects.add(project)
    }
  }
  return { projects: [...projects].sort(), fullProjects: [...fullProjects].sort(), smoke: [] }
}

function moduleInput(path) {
  return /\.[cm]?[jt]sx?$/.test(path)
    && !/(?:^|\/)(?:vitest[^/]*|tsconfig[^/]*|eslint[^/]*|next\.config|open-next\.config|.*setup[^/]*|.*env[^/]*)\.[^/]+$/.test(path)
}

export function projectFullReason(plan) {
  if (plan.full) return plan.full_reason || "full_policy"
  if (plan.changes.some((change) => !change.status.startsWith("M"))) return "added_deleted_or_renamed_input"
  if (plan.paths.some((path) => !moduleInput(path))) return "nonmodule_input"
  return null
}

export async function selectUnitSpecifications(ctx, plan, scope, { ci = false } = {}) {
  const allowedProjects = scope.projects && new Set(scope.projects)
  const inScope = (spec) => !allowedProjects || allowedProjects.has(spec.project.name)
  const discovered = (await ctx.globTestSpecifications(scope.smoke)).filter(inScope)
  const delegated = ci ? discovered.filter(spec => dedicatedFiles.has(spec.moduleId)) : []
  const eligible = spec => inScope(spec) && (!ci || !dedicatedFiles.has(spec.moduleId))
  const all = discovered.filter(eligible)
  const fullReason = scope.smoke.length ? "main_smoke" : projectFullReason(plan)
  let selected
  let fallback = null
  if (fullReason) selected = all
  else {
    try {
      selected = all.length ? (await ctx.getRelevantTestSpecifications(all.map((spec) => spec.moduleId))).filter(eligible) : []
    } catch (error) {
      fallback = { reason: "native_related_analysis_failed", detail: error instanceof Error ? error.message : String(error) }
      selected = all
    }
    const fullProjects = new Set(scope.fullProjects)
    const directlyChanged = new Set(plan.changes.flatMap((change) => [
      resolve(ROOT, change.path), ...(change.old_path ? [resolve(ROOT, change.old_path)] : []),
    ]))
    selected.push(...all.filter((spec) => fullProjects.has(spec.project.name) || directlyChanged.has(spec.moduleId)))
  }
  const identity = (spec) => JSON.stringify([spec.project.name, spec.moduleId])
  const specs = [...new Map(selected.map((spec) => [identity(spec), spec])).values()]
    .sort((left, right) => identity(left).localeCompare(identity(right)))
  return {
    specs,
    receipt: {
      plan_hash: plan.plan_hash,
      mode: fallback ? "project_full" : fullReason || "native_related",
      fallback,
      cache: "bypassed",
      execution: null,
      discovered_files: discovered.length,
      delegated_files: delegated.map(spec => ({ project: spec.project.name, file: relative(ROOT, spec.moduleId).replaceAll("\\", "/") })),
      selected_files: specs.length,
      projects: scope.projects || [],
      files: specs.map((spec) => ({ project: spec.project.name, file: relative(ROOT, spec.moduleId).replaceAll("\\", "/") })),
    },
  }
}

export async function runUnitTests(plan, { ci = false, list = false, receiptFile, coverage = false } = {}) {
  validateExecutionPlan(plan)
  const scope = unitProjects(plan)
  if (scope.projects?.length === 0 && !scope.smoke.length) return null
  process.env.TEST = "true"
  process.env.VITEST = "true"
  process.env.NODE_ENV ??= "test"
  const opts = {
    root: ROOT,
    watch: false,
    project: coverage ? undefined : scope.projects,
    passWithNoTests: coverage,
    related: plan.full || scope.smoke.length ? undefined : plan.paths.map((path) => resolve(ROOT, path)),
    ...(coverage ? {
      coverage: {
        enabled: true,
        provider: "istanbul",
        include: plan.coverage.include_roots,
        reporter: ["json", "text"],
        reportOnFailure: true,
      },
      reporters: ["default", "blob"],
      outputFile: { blob: resolve(ROOT, ".vitest-reports/unit.blob") },
    } : {}),
  }
  const ctx = await createVitest(opts)
  try {
    if (coverage && !list) await ctx.standalone()
    const selected = await selectUnitSpecifications(ctx, plan, scope, { ci })
    if (receiptFile) {
      mkdirSync(dirname(resolve(receiptFile)), { recursive: true })
      writeFileSync(receiptFile, JSON.stringify(selected.receipt, null, 2) + "\n")
    }
    process.stdout.write(JSON.stringify(selected.receipt, null, 2) + "\n")
    if (list || (selected.specs.length === 0 && !coverage)) return selected.receipt
    if (!coverage) await ctx.standalone()
    const result = await ctx.runTestSpecifications(selected.specs, true)
    selected.receipt.execution = {
      unhandled_errors: result.unhandledErrors.length,
      files: result.testModules.map((module) => ({
        project: module.project.name,
        file: relative(ROOT, module.moduleId).replaceAll("\\", "/"),
        state: module.state(),
        ok: module.ok(),
      })),
    }
    if (receiptFile) writeFileSync(receiptFile, JSON.stringify(selected.receipt, null, 2) + "\n")
    if (result.unhandledErrors.length || result.testModules.some((module) => !module.ok())) {
      throw new Error("selected unit tests failed")
    }
    const actual = new Set(result.testModules.map((module) => JSON.stringify([module.project.name, module.moduleId])))
    if (selected.specs.some((spec) => !actual.has(JSON.stringify([spec.project.name, spec.moduleId])))) {
      throw new Error("selected unit test did not execute")
    }
    return selected.receipt
  } finally {
    await ctx.close()
  }
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const args = { ci: false, list: false, coverage: false }
  let planFile
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === "--ci") args.ci = true
    else if (flag === "--list") args.list = true
    else if (flag === "--coverage") args.coverage = true
    else if (flag === "--receipt") args.receiptFile = argv[++index]
    else if (flag === "--plan") planFile = argv[++index]
    else throw new Error("unknown or incomplete unit option: " + flag)
  }
  const plan = planFile ? validateExecutionPlan(JSON.parse(readFileSync(planFile, "utf8")))
    : validatePlanEnvelope({ planJson: env.CI_EXECUTION_PLAN, planFile: env.CI_EXECUTION_PLAN_FILE, planHash: env.CI_PLAN_HASH })
  return runUnitTests(plan, args)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => { process.stderr.write(String(error) + "\n"); process.exitCode = 1 })
}
