import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import {
  loadScopeManifest,
  validateExecutionPlan,
} from "./changed-scopes.mjs"

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))

function normalizeReportPath(path, root) {
  const normalized = path.replaceAll("\\", "/")
  return (isAbsolute(normalized) ? relative(root, normalized) : normalized)
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
}

function statementCounts(file) {
  const counts = Object.values(file.s || {})
  return {
    statements: counts.length,
    covered: counts.filter((count) => Number(count) > 0).length,
  }
}

function uninstrumentedSourceKind(path) {
  if (!/\.[cm]?tsx?$/.test(path)) return null
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
  if (source.parseDiagnostics.length > 0 || source.statements.length === 0) return null
  let prologue = true
  let hasTypes = false
  let hasReExports = false
  for (const statement of source.statements) {
    if (prologue && ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)
      && ["use client", "use server", "use strict"].includes(statement.expression.text)) continue
    prologue = false
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)
      || (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true)
      || (ts.isExportDeclaration(statement) && statement.isTypeOnly)) {
      hasTypes = true
      continue
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier) && !statement.attributes) {
      hasReExports = true
      continue
    }
    return null
  }
  return hasReExports ? "re_export" : hasTypes ? "type_only" : null
}

export function verifyCoveragePlan(plan, report, options = {}) {
  const root = options.root || ROOT
  const manifest = options.manifest || loadScopeManifest()
  validateExecutionPlan(plan, { manifest })

  const files = Object.entries(report).map(([key, value]) => ({
    path: normalizeReportPath(value.path || key, root),
    coverage: value,
  }))
  const reportPaths = new Set(files.map((entry) => entry.path))
  const typeOnlyChangedFiles = []
  const reExportChangedFiles = []

  for (const path of plan.coverage.required_changed_files) {
    if (!existsSync(resolve(root, path))) {
      throw new Error(`required changed coverage file does not exist at head: ${path}`)
    }
    if (!reportPaths.has(path)) {
      const kind = uninstrumentedSourceKind(resolve(root, path))
      if (kind) {
        if (kind === "type_only") typeOnlyChangedFiles.push(path)
        else reExportChangedFiles.push(path)
        continue
      }
      throw new Error(`required changed coverage file is missing from merged report: ${path}`)
    }
  }

  const targets = {}
  for (const targetName of plan.coverage.targets) {
    const target = manifest.codecov_targets[targetName]
    if (!target) throw new Error(`unknown Codecov project target: ${targetName}`)
    const targetFiles = files.filter((entry) => (
      entry.path === target.path || entry.path.startsWith(`${target.path}/`)
    ))
    const totals = targetFiles.reduce((sum, entry) => {
      const counts = statementCounts(entry.coverage)
      sum.statements += counts.statements
      sum.covered += counts.covered
      return sum
    }, { statements: 0, covered: 0 })
    if (targetFiles.length === 0 || totals.statements === 0) {
      throw new Error(`Codecov project target ${targetName} requires a nonempty denominator`)
    }
    const percent = (totals.covered / totals.statements) * 100
    if (percent < target.target) {
      throw new Error(
        `Codecov project target ${targetName} is ${percent.toFixed(2)}%, below ${target.target}%`,
      )
    }
    targets[targetName] = {
      path: target.path,
      target: target.target,
      files: targetFiles.length,
      statements: totals.statements,
      covered: totals.covered,
      percent,
    }
  }

  return {
    schema_version: plan.schema_version,
    policy_version: plan.policy_version,
    plan_hash: plan.plan_hash,
    include_roots: plan.coverage.include_roots,
    required_changed_files: plan.coverage.required_changed_files,
    type_only_changed_files: typeOnlyChangedFiles,
    re_export_changed_files: reExportChangedFiles,
    report_files: [...reportPaths].sort(),
    targets,
  }
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    args[key] = argv[++index]
  }
  return args
}

export function runCli(argv) {
  const args = parseArgs(argv)
  if (!args.plan || !args.report || !args.output) {
    throw new Error("--plan, --report, and --output are required")
  }
  const plan = JSON.parse(readFileSync(resolve(args.plan), "utf8"))
  const report = JSON.parse(readFileSync(resolve(args.report), "utf8"))
  const result = verifyCoveragePlan(plan, report)
  writeFileSync(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(
    `Verified ${result.required_changed_files.length} changed coverage files across ${Object.keys(result.targets).length} Codecov project targets.\n`,
  )
}

export function runIfMain(metaUrl, argvPath = process.argv[1], argv = process.argv.slice(2)) {
  if (argvPath === fileURLToPath(metaUrl)) {
    runCli(argv)
  }
}

runIfMain(import.meta.url)
