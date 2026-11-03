import { execFileSync, spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildExecutionPlan, parseNameStatus, queryNativeTasks, stablePlanJson } from "./changed-scopes.mjs"
import { isolatedRepositoryGitEnvironment } from "./report-changed-patch-coverage.mjs"

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))

export function collectLocalChanges({ root = ROOT, base } = {}) {
  const git = (...args) => execFileSync("git", args, {
    cwd: root,
    env: { ...isolatedRepositoryGitEnvironment(), GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const baseSha = base
    ? git("rev-parse", "--verify", base).toString().trim()
    : git("merge-base", "HEAD", "origin/main").toString().trim()
  const diffOptions = ["--name-status", "-z", "--find-renames", "--find-copies"]
  const changes = [
    ...parseNameStatus(git("diff", ...diffOptions, baseSha, "HEAD", "--")),
    ...parseNameStatus(git("diff", "--cached", ...diffOptions, "HEAD", "--")),
    ...parseNameStatus(git("diff", ...diffOptions, "--")),
  ]
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean)
  const uniqueChanges = new Map([...changes, ...untracked.map((path) => ({ status: "A", path }))]
    .map((change) => [JSON.stringify([change.status, change.old_path ?? "", change.path]), change]))
  return {
    changes: [...uniqueChanges.values()],
    baseSha,
    headSha: git("rev-parse", "HEAD").toString().trim(),
  }
}

export function localCheckCommands(plan) {
  if (plan.full) return ["typecheck", "lint", "test", "typegrep:ws", "typegrep:agent-driver", "knip"]
    .map((script) => ["pnpm", script])
  const commands = []
  const turbo = (tasks) => {
    if (tasks.length) commands.push(["node", "scripts/ci/run-turbo.mjs", "run", ...tasks])
  }
  turbo(plan.suites.static_tasks.filter((task) => task.split("#")[1].startsWith("typecheck")))
  turbo(plan.suites.static_tasks.filter((task) => task.split("#")[1].startsWith("lint")))
  turbo(plan.suites.unit_build_tasks)
  if (plan.suites.unit_tasks.length) commands.push(["node", "scripts/ci/run-unit-tests.mjs", "--plan", ".ci/local-execution-plan.json"])
  if (plan.suites.static.some((name) => ["@alook/web", "@alook/shared", "@alook/ws-do"].includes(name))) {
    commands.push(["pnpm", "typegrep:ws"])
  }
  if (plan.suites.static.some((name) => ["@alook/agent-driver", "@alook/daemon"].includes(name))) {
    commands.push(["pnpm", "typegrep:agent-driver"])
  }
  turbo(plan.suites.knip_tasks)
  return commands
}

export function runLocalChecks(plan, { root = ROOT, execute = spawnSync } = {}) {
  if (!plan.full && plan.suites.unit_tasks.length) {
    const file = resolve(root, ".ci/local-execution-plan.json")
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, stablePlanJson(plan) + "\n")
  }
  for (const [command, ...args] of localCheckCommands(plan)) {
    const result = execute(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.signal || result.status})`)
  }
}

export function runCli(argv = process.argv.slice(2)) {
  let base
  let forceFull = false
  let planOnly = false
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--full") forceFull = true
    else if (argv[index] === "--plan") planOnly = true
    else if (argv[index] === "--base" && argv[index + 1]) base = argv[++index]
    else throw new Error(`unknown or incomplete local check option: ${argv[index]}`)
  }
  let plan
  try {
    const input = collectLocalChanges({ base })
    plan = buildExecutionPlan(input.changes, { ...input, forceFull, nativeTasks: queryNativeTasks(input) })
  } catch (error) {
    plan = buildExecutionPlan([], { forceFull: true, fallbackReason: String(error) })
  }
  if (planOnly) process.stdout.write(`${JSON.stringify({ plan, commands: localCheckCommands(plan) }, null, 2)}\n`)
  else runLocalChecks(plan)
  return plan
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli()
