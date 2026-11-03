import { execFileSync, spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { isolatedRepositoryGitEnvironment } from "./report-changed-patch-coverage.mjs"
import { validatePlanEnvelope } from "./validate-execution-plan.mjs"

const ROOT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)))

export function taskEnvironment(root = ROOT) {
  let bun = "unavailable"
  try { bun = execFileSync("bun", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() } catch {}
  const libc = process.platform === "linux" ? "-glibc" + (process.report.getReport().header.glibcVersionRuntime || "unavailable") : ""
  return {
    ...isolatedRepositoryGitEnvironment(),
    ALOOK_TASK_PLATFORM: process.platform + "-" + process.arch + libc,
    ALOOK_TASK_NODE: process.versions.node,
    ALOOK_TASK_BUN: bun,
    ALOOK_TASK_WORKSPACE: realpathSync(root),
  }
}

function invokeTurbo(args, { root, stdio, environment }) {
  return spawnSync("pnpm", ["exec", "turbo", ...args], {
    cwd: root,
    env: environment,
    stdio,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  })
}

export function executeTurbo(args, { root = ROOT, stdio = "inherit" } = {}) {
  return invokeTurbo(args, { root, stdio, environment: taskEnvironment(root) })
}

export function queryTurboTasks(tasks, { root = ROOT, nodeVersion } = {}) {
  if (!tasks.length || tasks.some(task => typeof task !== "string" || !task || task.startsWith("-"))) {
    throw new Error("native dry query requires named tasks")
  }
  const environment = taskEnvironment(root)
  if (nodeVersion !== undefined) environment.ALOOK_TASK_NODE = nodeVersion
  return invokeTurbo(["run", ...tasks, "--dry=json"], {
    root, stdio: ["ignore", "pipe", "pipe"], environment,
  })
}

export function runCli(argv = process.argv.slice(2)) {
  let args = argv
  if (args[0] === "--plan-group") {
    const group = args[1]
    if (!["static_tasks", "build_tasks", "knip_tasks", "unit_build_tasks"].includes(group)) throw new Error("unknown native task group")
    const plan = validatePlanEnvelope({ planJson: process.env.CI_EXECUTION_PLAN, planFile: process.env.CI_EXECUTION_PLAN_FILE, planHash: process.env.CI_PLAN_HASH })
    if (!plan.native_tasks) throw new Error("native task inventory is required for execution")
    if (!plan.suites[group].length) return
    args = ["run", ...plan.suites[group], ...args.slice(2)]
  }
  const result = executeTurbo(args)
  if (result.error) throw result.error
  if (result.signal) process.kill(process.pid, result.signal)
  else process.exitCode = result.status ?? 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli()
