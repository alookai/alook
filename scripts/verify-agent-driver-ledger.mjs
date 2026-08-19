#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ledgerPath = path.join(repoRoot, "plans/agent-driver-atomic-cutover-ledger.json")
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-driver-ledger-"))

const projects = [
  ["driver", "src/daemon/agent-driver"],
  ["daemon", "src/daemon"],
  ["shared", "src/shared"],
  ["web", "src/web"],
]

try {
  const collected = []
  const counts = {}
  for (const [name, project] of projects) {
    const output = path.join(tempRoot, `${name}.json`)
    execFileSync("pnpm", ["-C", project, "exec", "vitest", "list", `--json=${output}`], {
      cwd: repoRoot,
      stdio: "inherit",
    })
    const tests = JSON.parse(fs.readFileSync(output, "utf8"))
    counts[name] = tests.length
    collected.push(...tests)
  }

  const keys = new Set(collected.map((test) => {
    const relative = path.relative(repoRoot, test.file).split(path.sep).join("/")
    return `${relative}\0${test.name}`
  }))
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"))
  const missing = ledger.testPreservation.mappings.flatMap((mapping, index) => {
    if (!mapping.after) return []
    const key = `${mapping.after.file}\0${mapping.after.name}`
    return keys.has(key) ? [] : [{ index, after: mapping.after, disposition: mapping.disposition }]
  })
  const approvedContractChanges = ledger.testPreservation.mappings
    .filter((mapping) => mapping.disposition === "approved_contract_change")
    .length

  const result = {
    counts,
    totalCollectedCases: collected.length,
    mappingCount: ledger.testPreservation.mappings.length,
    approvedContractChanges,
    missing,
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

  if (missing.length > 0) process.exitCode = 1
  if (ledger.testPreservation.finalCollectedCases !== collected.length) process.exitCode = 1
  if (ledger.testPreservation.verification.mappingCount !== ledger.testPreservation.mappings.length) process.exitCode = 1
  if (ledger.testPreservation.verification.approvedContractChanges !== approvedContractChanges) process.exitCode = 1
  if (!ledger.testPreservation.verification.everyNonDeletedCaseNamesExistingFinalTest) process.exitCode = 1
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
