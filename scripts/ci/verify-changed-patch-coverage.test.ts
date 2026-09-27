import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  collectChangedPatchCoverage,
  executableLineCounters,
  isolatedRepositoryGitEnvironment,
  parseAddedLines,
  runCli,
} from "./verify-changed-patch-coverage.mjs"

function location(line: number) {
  return { start: { line, column: 0 }, end: { line, column: 1 } }
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: isolatedRepositoryGitEnvironment(),
  }).trim()
}

function fixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), "changed-patch-coverage-"))
  git(root, "init", "--quiet")
  const hooksPath = join(root, ".git", "fixture-hooks")
  mkdirSync(hooksPath)
  git(root, "config", "core.hooksPath", hooksPath)
  git(root, "config", "user.email", "coverage@example.test")
  git(root, "config", "user.name", "Coverage Test")
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src/base.mjs"), "export const base = 1\n")
  git(root, "add", "src/base.mjs")
  git(root, "commit", "--quiet", "-m", "base")
  return root
}

function poisonParentGitEnvironment() {
  const parent = mkdtempSync(join(tmpdir(), "changed-patch-parent-"))
  git(parent, "init", "--quiet")
  git(parent, "config", "user.email", "parent@example.test")
  git(parent, "config", "user.name", "Parent Test")
  writeFileSync(join(parent, "parent.mjs"), "export const parent = true\n")
  git(parent, "add", "parent.mjs")
  git(parent, "commit", "--quiet", "-m", "parent")

  const parentGitDir = join(parent, ".git")
  const parentIndex = join(parentGitDir, "index")
  const parentIndexBefore = readFileSync(parentIndex)
  const parentHookMarker = join(parent, "parent-hook-ran")
  const parentHooksPath = join(parentGitDir, "parent-hooks")
  mkdirSync(parentHooksPath)
  const parentHook = join(parentHooksPath, "pre-commit")
  writeFileSync(parentHook, [
    "#!/bin/sh",
    `touch '${parentHookMarker}'`,
    "exit 1",
    "",
  ].join("\n"))
  chmodSync(parentHook, 0o755)
  git(parent, "config", "core.hooksPath", parentHooksPath)

  const previousGitEnv = new Map<string, string | undefined>()
  const poisonedGitEnv = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(parentGitDir, "objects"),
    GIT_COMMON_DIR: parentGitDir,
    GIT_DIR: parentGitDir,
    GIT_INDEX_FILE: parentIndex,
    GIT_OBJECT_DIRECTORY: join(parentGitDir, "objects"),
    GIT_PREFIX: "poisoned/",
    GIT_QUARANTINE_PATH: join(parentGitDir, "objects"),
    GIT_WORK_TREE: parent,
  }
  for (const [name, value] of Object.entries(poisonedGitEnv)) {
    previousGitEnv.set(name, process.env[name])
    process.env[name] = value
  }

  return {
    expectUnchanged() {
      expect(readFileSync(parentIndex)).toEqual(parentIndexBefore)
      expect(existsSync(parentHookMarker)).toBe(false)
    },
    restore() {
      for (const [name, value] of previousGitEnv) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(parent, { recursive: true, force: true })
    },
  }
}

function writeReport(root: string, path: string, count: number) {
  const reportPath = join(root, "report.json")
  writeFileSync(reportPath, JSON.stringify({
    [join(root, path)]: {
      path: join(root, path),
      statementMap: { "0": location(1) },
      s: { "0": count },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    },
  }))
  return reportPath
}

describe("changed patch coverage", () => {
  it("parses added and replaced head lines without counting deletions", () => {
    const changed = parseAddedLines([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      "@@ -8,2 +9,0 @@",
      "diff --git a/src/deleted.ts b/src/deleted.ts",
      "--- a/src/deleted.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
    ].join("\n"))

    expect([...changed.get("src/a.ts")!]).toEqual([1, 2, 3])
    expect(changed.has("src/deleted.ts")).toBe(false)
  })

  it("uses statement starts, function body starts, and every branch-arm start", () => {
    const report = {
      "/host/work/repo/src/a.ts": {
        path: "/host/work/repo/src/a.ts",
        statementMap: {
          "0": location(2),
          "1": location(6),
          "2": location(7),
        },
        s: { "0": 3, "1": 0, "2": 2 },
        fnMap: {
          "0": { name: "run", decl: location(1), loc: location(3) },
        },
        f: { "0": 1 },
        branchMap: {
          "0": { type: "cond-expr", locations: [location(4), location(5)] },
          "1": { type: "binary-expr", locations: [location(7)] },
        },
        b: { "0": [0, 2], "1": [0] },
      },
    }
    const changed = new Map([["src/a.ts", new Set([1, 2, 3, 4, 5, 6, 7])]])

    const result = collectChangedPatchCoverage(changed, report, { root: "/repo" })

    expect(result).toMatchObject({
      covered_lines: 4,
      missed_lines: 2,
      total_lines: 6,
      files: [{ path: "src/a.ts", missed_lines: [4, 6] }],
    })
    expect(result.files[0]!.lines.map(({ line }) => line)).not.toContain(1)
    expect(result.files[0]!.lines.find(({ line }) => line === 7)).toMatchObject({ covered: true })
  })

  it("merges counters for the same line across coverage sessions", () => {
    const file = {
      statementMap: { "0": location(8) },
      s: { "0": 0 },
      fnMap: {},
      f: {},
      branchMap: { "0": { type: "binary-expr", locations: [location(8)] } },
      b: { "0": [4] },
    }

    expect(executableLineCounters(file).get(8)).toEqual([
      { kind: "statement", id: "0", count: 0 },
      { kind: "branch", id: "0", arm: 0, branchType: "binary-expr", count: 4 },
    ])
  })

  it("ignores report paths that cannot be mapped to exactly one changed file", () => {
    const changed = new Map([
      ["one/src/a.ts", new Set([1])],
      ["two/src/a.ts", new Set([1])],
    ])
    const report = {
      "/host/src/a.ts": {
        path: "/host/src/a.ts",
        statementMap: { "0": location(1) },
        s: { "0": 1 },
      },
    }

    expect(collectChangedPatchCoverage(changed, report, { root: "/repo" }))
      .toMatchObject({ total_lines: 0, percent: 100, files: [] })
  })

  it("sorts covered changed files by repository path", () => {
    const changed = new Map([
      ["src/z.ts", new Set([1])],
      ["src/a.ts", new Set([1])],
    ])
    const coveredFile = (path: string) => ({
      path,
      statementMap: { "0": location(1) },
      s: { "0": 1 },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    })

    const result = collectChangedPatchCoverage(changed, {
      "/repo/src/z.ts": coveredFile("/repo/src/z.ts"),
      "/repo/src/a.ts": coveredFile("/repo/src/a.ts"),
    }, { root: "/repo" })

    expect(result.files.map((file) => file.path)).toEqual(["src/a.ts", "src/z.ts"])
  })

  it("includes untracked worktree source and writes a successful CLI report", () => {
    const parent = poisonParentGitEnvironment()
    let root: string | undefined
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      root = fixtureRepository()
      expect(git(root, "rev-parse", "HEAD")).toMatch(/^[0-9a-f]{40}$/)
      writeFileSync(join(root, "src/new.mjs"), "export const added = true\n")
      const reportPath = writeReport(root, "src/new.mjs", 1)
      const outputPath = join(root, "result.json")

      const result = runCli([
        "--base", "HEAD",
        "--report", reportPath,
        "--root", root,
        "--head", "WORKTREE",
        "--output", outputPath,
        "--unused-option", "covered",
      ])

      expect(result).toMatchObject({ covered_lines: 1, missed_lines: 0, total_lines: 1 })
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({ percent: 100 })
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("1/1 lines"))
      parent.expectUnchanged()
    } finally {
      stdout.mockRestore()
      parent.restore()
      if (root) rmSync(root, { recursive: true, force: true })
    }
  })

  it("supports an explicit head and reports every missed file before failing", () => {
    const parent = poisonParentGitEnvironment()
    let root: string | undefined
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      root = fixtureRepository()
      const base = git(root, "rev-parse", "HEAD")
      writeFileSync(join(root, "src/base.mjs"), "export const base = 2\n")
      git(root, "add", "src/base.mjs")
      git(root, "commit", "--quiet", "-m", "head")
      const reportPath = writeReport(root, "src/base.mjs", 0)

      expect(() => runCli([
        "--base", base,
        "--head", "HEAD",
        "--report", reportPath,
        "--root", root,
      ])).toThrow("changed patch has 1 uncovered executable lines")
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("0/1 lines"))
      expect(stdout).toHaveBeenCalledWith("src/base.mjs: 1\n")
      parent.expectUnchanged()
    } finally {
      stdout.mockRestore()
      parent.restore()
      if (root) rmSync(root, { recursive: true, force: true })
    }
  })

  it("requires the CLI inputs before invoking git", () => {
    expect(() => runCli([])).toThrow("--base and --report")
  })
})
