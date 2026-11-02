import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { buildExecutionPlan } from "./changed-scopes.mjs"
import { collectLocalChanges, localCheckCommands, runLocalChecks } from "./check-local.mjs"
import { isolatedRepositoryGitEnvironment } from "./report-changed-patch-coverage.mjs"

function repository(files: Record<string, string> = { "base.ts": "export const base = 1\n" }) {
  const root = mkdtempSync(join(tmpdir(), "alook-local-check-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: isolatedRepositoryGitEnvironment(), encoding: "utf8" })
  try {
    git("init", "--quiet")
    git("config", "user.name", "Local Check")
    git("config", "user.email", "local@example.test")
    git("config", "commit.gpgsign", "false")
    mkdirSync(join(root, "fixture-hooks"))
    git("config", "core.hooksPath", join(root, "fixture-hooks"))
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    git("add", ".")
    git("commit", "--quiet", "-m", "base")
    const base = git("rev-parse", "HEAD").trim()
    git("update-ref", "refs/remotes/origin/main", base)
    return { root, git, base }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

describe("local canonical checks", () => {
  it.each(["staged modification", "committed modification", "staged rename", "staged deletion"])(
    "retains runtime scope when the final disk cancels a %s", (kind) => {
      const runtime = "src/web/src/components/community/shell/user-bar.tsx"
      const baseline = "export const original = true\n"
      const { root, git } = repository({ [runtime]: baseline, "README.md": "base\n" })
      try {
        if (kind === "staged rename") {
          git("mv", runtime, "moved-runtime.md")
          unlinkSync(join(root, "moved-runtime.md"))
        } else if (kind === "staged deletion") git("rm", runtime)
        else {
          writeFileSync(join(root, runtime), "export const changed = true\n")
          git("add", runtime)
          if (kind === "committed modification") git("commit", "--quiet", "-m", "runtime")
        }
        mkdirSync(dirname(join(root, runtime)), { recursive: true })
        writeFileSync(join(root, runtime), baseline)
        if (kind === "committed modification") git("add", runtime)
        writeFileSync(join(root, "README.md"), "documentation changed\n")
        const index = readFileSync(join(root, ".git/index"))
        const input = collectLocalChanges({ root })
        expect(input.changes.some((change) => change.path === runtime || change.old_path === runtime)).toBe(true)
        if (kind === "staged rename") expect(input.changes).toContainEqual({ status: "R100", old_path: runtime, path: "moved-runtime.md" })
        if (kind === "staged deletion") expect(input.changes).toContainEqual({ status: "D", path: runtime })
        const plan = buildExecutionPlan(input.changes)
        expect(plan.docs_only).toBe(false)
        expect(plan.suites.static).toContain("@alook/web")
        expect(localCheckCommands(plan).some((command) => command.includes("--filter=@alook/web"))).toBe(true)
        expect(readFileSync(join(root, ".git/index"))).toEqual(index)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it("includes branch commits, staged, unstaged and untracked source without changing the index", () => {
    const { root, git, base } = repository()
    try {
      writeFileSync(join(root, "committed.ts"), "export const committed = 1\n")
      git("add", ".")
      git("commit", "--quiet", "-m", "branch")
      writeFileSync(join(root, "staged.ts"), "export const staged = 1\n")
      git("add", "staged.ts")
      writeFileSync(join(root, "base.ts"), "export const base = 2\n")
      writeFileSync(join(root, "untracked.ts"), "export const untracked = 1\n")
      const index = readFileSync(join(root, ".git/index"))
      const input = collectLocalChanges({ root })
      expect(input.baseSha).toBe(base)
      expect(input.changes).toEqual(expect.arrayContaining([
        { status: "M", path: "base.ts" },
        { status: "A", path: "committed.ts" },
        { status: "A", path: "staged.ts" },
        { status: "A", path: "untracked.ts" },
      ]))
      expect(input.changes).toHaveLength(4)
      expect(readFileSync(join(root, ".git/index"))).toEqual(index)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps full checks available and affected driver tests after their build and other package tests", () => {
    const full = buildExecutionPlan([], { forceFull: true })
    expect(localCheckCommands(full)).toEqual([
      ["pnpm", "typecheck"], ["pnpm", "lint"], ["pnpm", "test"],
      ["pnpm", "typegrep:ws"], ["pnpm", "typegrep:agent-driver"], ["pnpm", "knip"],
    ])
    const plan = buildExecutionPlan([{ status: "M", path: "src/daemon/agent-driver/src/index.ts" }])
    const commands = localCheckCommands(plan)
    const build = commands.findIndex((command) => command.join(" ") === "pnpm --filter @alook/agent-driver build")
    const tests = commands.findIndex((command) => command.slice(0, 4).join(" ") === "pnpm turbo run test")
    const isolated = commands.findIndex((command) => command.join(" ") === "pnpm --filter @alook/agent-driver test")
    expect(build).toBeGreaterThanOrEqual(0)
    expect(tests).toBeGreaterThan(build)
    expect(isolated).toBeGreaterThan(tests)
    expect(commands[tests]).not.toContain("--filter=@alook/agent-driver")
    expect(localCheckCommands(buildExecutionPlan([{ status: "M", path: "README.md" }]))).toEqual([])
  })

  it("stops later checks at the first child failure or launch error", () => {
    const full = buildExecutionPlan([], { forceFull: true })
    const execute = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 7 })
    expect(() => runLocalChecks(full, { execute })).toThrow("failed (7)")
    expect(execute).toHaveBeenCalledTimes(2)
    const error = new Error("cannot launch")
    const launch = vi.fn().mockReturnValue({ error })
    expect(() => runLocalChecks(full, { execute: launch })).toThrow(error)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it("uses the real CLI in plan-only mode without starting package checks", () => {
    const output = execFileSync(process.execPath, ["scripts/ci/check-local.mjs", "--base", "HEAD", "--full", "--plan"], { encoding: "utf8" })
    const result = JSON.parse(output)
    expect(result.plan.base_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.plan.head_sha).toBe(result.plan.base_sha)
    expect(result.plan.full).toBe(true)
    expect(result.commands).toEqual(localCheckCommands(result.plan))
  })
})
