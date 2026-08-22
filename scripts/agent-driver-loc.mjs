#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ref = process.argv[2] || null

// Fixed for the lifetime of the atomic PR. New package code and every legacy
// driver/session/manager composition file share one denominator, so moves and
// temporary duplication cannot masquerade as production LOC reduction.
const scopeRoots = [
  "src/daemon/src/drivers",
  "src/daemon/src/runtime",
  "src/daemon/src/manager",
  "src/daemon/src/daemon/createDaemon.ts",
  "src/daemon/src/types.ts",
  "src/daemon/src/runtimeConfig.ts",
  "src/daemon/src/discovery.ts",
  "src/daemon/agent-driver/src",
]

function isProductionTypeScript(file) {
  return file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".spec.ts")
}

function currentFiles() {
  const files = []
  const visit = (relative) => {
    const absolute = path.join(repoRoot, relative)
    if (!fs.existsSync(absolute)) return
    const stat = fs.statSync(absolute)
    if (stat.isFile()) {
      if (isProductionTypeScript(relative)) files.push(relative)
      return
    }
    for (const entry of fs.readdirSync(absolute).sort()) {
      visit(path.posix.join(relative, entry))
    }
  }
  for (const root of scopeRoots) visit(root)
  return [...new Set(files)].sort()
}

function refFiles(gitRef) {
  const output = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", gitRef, "--", ...scopeRoots],
    { cwd: repoRoot, encoding: "utf8" },
  )
  return [...new Set(output.split("\n").filter(isProductionTypeScript))].sort()
}

function content(file) {
  if (!ref) return fs.readFileSync(path.join(repoRoot, file), "utf8")
  return execFileSync("git", ["show", `${ref}:${file}`], { cwd: repoRoot, encoding: "utf8" })
}

function physicalLines(text) {
  if (!text) return 0
  const lines = text.split(/\r?\n/)
  return lines.at(-1) === "" ? lines.length - 1 : lines.length
}

const files = ref ? refFiles(ref) : currentFiles()
const entries = files.map((file) => ({ file, lines: physicalLines(content(file)) }))
const result = {
  schemaVersion: 1,
  ref: ref ?? "WORKTREE",
  scopeRoots,
  excludes: ["**/*.test.ts", "**/*.spec.ts", "non-TypeScript files"],
  files: entries,
  total: entries.reduce((sum, entry) => sum + entry.lines, 0),
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
