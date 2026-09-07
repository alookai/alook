import { readFileSync, readdirSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"

export const auditExitCode = 2

function normalizedPath(value) {
  return value.split(sep).join("/")
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function occurrenceCount(source, pattern) {
  return [...source.matchAll(new RegExp(pattern, "g"))].length
}

export function countRendererMounts(source) {
  const defaultOwners = new Set()
  const createOwners = new Set()
  for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s+["']react-test-renderer["']/g)) {
    defaultOwners.add(match[1])
  }
  for (const match of source.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']react-test-renderer["']/g)) {
    defaultOwners.add(match[1])
  }
  for (const match of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(["']react-test-renderer["']\)/g)) {
    defaultOwners.add(match[1])
  }
  for (const match of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']react-test-renderer["']/g)) {
    const named = match[1]
    for (const item of named.split(",")) {
      const specifier = item.trim().replace(/^type\s+/, "")
      const create = specifier.match(/^create(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (create) createOwners.add(create[1] ?? "create")
    }
  }

  let mounts = 0
  for (const owner of defaultOwners) {
    mounts += occurrenceCount(source, `\\b${escapedPattern(owner)}\\s*\\.\\s*create\\s*\\(`)
  }
  for (const owner of createOwners) {
    mounts += occurrenceCount(source, `(?<![\\w$.])${escapedPattern(owner)}\\s*\\(`)
  }
  return mounts
}

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) files.push(path)
  }
  return files
}

export function scanRendererInventory(repositoryRoot) {
  const webRoot = resolve(repositoryRoot, "src/web")
  return sourceFiles(webRoot)
    .map((file) => ({
      path: normalizedPath(relative(repositoryRoot, file)),
      source: readFileSync(file, "utf8"),
    }))
    .filter(({ source }) => source.includes("react-test-renderer"))
    .map(({ path, source }) => ({ path, mounts: countRendererMounts(source) }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

export function countWarnings(output, patterns) {
  return Object.fromEntries(Object.entries(patterns).map(([name, pattern]) => [
    name,
    output.split(pattern).length - 1,
  ]))
}

export function loadAuditContract(contractPath) {
  const contract = JSON.parse(readFileSync(contractPath, "utf8"))
  if (contract.schemaVersion !== 1) throw new Error("audit contract schemaVersion must be 1")
  if (!contract.patterns || !contract.fresh || !contract.expected) {
    throw new Error("audit contract is missing patterns, fresh, or expected")
  }
  if (!contract.globalWarningReduction || !contract.expected.warnings
    || !contract.expected.warningExclusiveUpperBounds) {
    throw new Error("audit contract is missing exact or upper-bound warning budgets")
  }
  const exactNames = Object.keys(contract.expected.warnings).sort()
  const upperBoundNames = Object.keys(contract.expected.warningExclusiveUpperBounds).sort()
  if (exactNames.length === 0 || upperBoundNames.length === 0
    || exactNames.some((name) => upperBoundNames.includes(name))
    || JSON.stringify(Object.keys(contract.globalWarningReduction).sort()) !== JSON.stringify(exactNames)
    || exactNames.some((name) => !Number.isSafeInteger(contract.expected.warnings[name])
      || contract.expected.warnings[name] < 0
      || !Number.isSafeInteger(contract.globalWarningReduction[name])
      || contract.globalWarningReduction[name] < 0)
    || upperBoundNames.some((name) => (
      !Number.isSafeInteger(contract.expected.warningExclusiveUpperBounds[name])
      || contract.expected.warningExclusiveUpperBounds[name] <= 0
    ))
    || [...exactNames, ...upperBoundNames].some((name) => (
      typeof contract.patterns[name] !== "string" || contract.patterns[name].length === 0
      || !Number.isSafeInteger(contract.fresh.warnings[name])
    ))) {
    throw new Error("audit contract warning budget keys must match patterns and fresh counts")
  }
  if (!contract.observedWarnings
    || JSON.stringify(Object.keys(contract.observedWarnings).sort()) !== JSON.stringify(upperBoundNames)
    || Object.entries(contract.observedWarnings).some(([name, counts]) => (
      !Array.isArray(counts) || counts.length === 0
      || counts.some((count) => !Number.isSafeInteger(count) || count < 0
        || count >= contract.expected.warningExclusiveUpperBounds[name])
    ))) {
    throw new Error("audit contract observed warnings must be below their exclusive upper bounds")
  }
  if (!Array.isArray(contract.residual) || !Array.isArray(contract.migratedFiles)) {
    throw new Error("audit contract is missing residual or migratedFiles")
  }
  if (!Number.isFinite(contract.maxWallTimeMs) || contract.maxWallTimeMs <= 0) {
    throw new Error("audit contract maxWallTimeMs must be positive")
  }
  return contract
}

export function validateInventory(contract, actual) {
  const errors = []
  if (actual.length !== contract.expected.rendererFiles) {
    errors.push(`renderer files: expected ${contract.expected.rendererFiles}, received ${actual.length}`)
  }
  const mounts = actual.reduce((total, entry) => total + entry.mounts, 0)
  if (mounts !== contract.expected.rendererMounts) {
    errors.push(`renderer mounts: expected ${contract.expected.rendererMounts}, received ${mounts}`)
  }
  if (JSON.stringify(actual) !== JSON.stringify(contract.residual)) {
    errors.push("renderer residual ownership differs from the contract")
  }
  return errors
}

export function validateWarningBudget(contract, output, elapsedMs, childExitCode) {
  const errors = []
  const counts = countWarnings(output, contract.patterns)
  for (const [name, expected] of Object.entries(contract.expected.warnings)) {
    if (counts[name] !== expected) {
      errors.push(`${name} warnings: expected ${expected}, received ${counts[name] ?? 0}`)
    }
    const fresh = contract.fresh.warnings[name]
    const reduction = contract.globalWarningReduction[name]
    if (expected !== fresh - reduction) {
      errors.push(`${name} warning budget does not equal fresh minus global reduction`)
    }
  }
  for (const [name, upperBound] of Object.entries(contract.expected.warningExclusiveUpperBounds)) {
    if (counts[name] >= upperBound) {
      errors.push(`${name} warnings: expected below ${upperBound}, received ${counts[name] ?? 0}`)
    }
    if (upperBound !== contract.fresh.warnings[name]) {
      errors.push(`${name} warning upper bound does not equal fresh baseline`)
    }
  }
  if (elapsedMs > contract.maxWallTimeMs) {
    errors.push(`wall time ${elapsedMs}ms exceeds ${contract.maxWallTimeMs}ms`)
  }
  return {
    counts,
    errors,
    exitCode: childExitCode === 0 && errors.length > 0 ? auditExitCode : childExitCode,
  }
}

export async function streamCommand(command, options = {}) {
  const startedAt = Date.now()
  const output = []
  const child = (options.spawn ?? spawn)(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["inherit", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk) => {
    output.push(chunk.toString())
    ;(options.stdout ?? process.stdout).write(chunk)
  })
  child.stderr.on("data", (chunk) => {
    output.push(chunk.toString())
    ;(options.stderr ?? process.stderr).write(chunk)
  })
  const exitCode = await new Promise((complete) => {
    child.once("error", () => complete(auditExitCode))
    child.once("close", (code) => complete(code ?? auditExitCode))
  })
  return { exitCode, output: output.join(""), elapsedMs: Date.now() - startedAt }
}

export function migratedCommand(file) {
  if (!file.startsWith("src/web/")) throw new Error(`migrated file is outside Web: ${file}`)
  return [
    "pnpm", "--filter", "@alook/web", "exec", "vitest", "run",
    "--config", "vitest.dom.config.ts", file.slice("src/web/".length),
    "--no-file-parallelism", "--maxWorkers=1", "--reporter=dot",
  ]
}

export function fullAuditCommand(vitestArgs = []) {
  const hasExplicitProject = vitestArgs.some((argument) => (
    argument === "--project" || argument.startsWith("--project=")
  ))
  const projectArgs = hasExplicitProject ? [] : [
    "--project=web-node",
    "--project=web-dom",
    "--project=web-runtime",
    "--project=auth-node",
    "--project=auth-runtime",
  ]
  return [
    "pnpm", "vitest", "run", ...projectArgs, "--no-file-parallelism",
    "--maxWorkers=1", "--reporter=dot", ...vitestArgs,
  ]
}

export async function runAudit(contractPath, options = {}) {
  const repositoryRoot = options.repositoryRoot ?? process.cwd()
  const contract = loadAuditContract(resolve(repositoryRoot, contractPath))
  const inventoryErrors = validateInventory(contract, scanRendererInventory(repositoryRoot))
  if (inventoryErrors.length > 0) {
    for (const error of inventoryErrors) (options.stderr ?? process.stderr).write(`${error}\n`)
    return auditExitCode
  }

  for (const file of contract.migratedFiles) {
    const result = await streamCommand(migratedCommand(file), { ...options, cwd: repositoryRoot })
    const warnings = countWarnings(result.output, contract.patterns)
    if (result.exitCode !== 0 || Object.values(warnings).some((count) => count !== 0)) {
      ;(options.stderr ?? process.stderr).write(
        `${file} failed isolated migrated-owner validation: ${JSON.stringify(warnings)}\n`,
      )
      return result.exitCode === 0 ? auditExitCode : result.exitCode
    }
  }

  const result = await streamCommand(fullAuditCommand(options.vitestArgs), {
    ...options,
    cwd: repositoryRoot,
  })
  const audit = validateWarningBudget(contract, result.output, result.elapsedMs, result.exitCode)
  ;(options.stderr ?? process.stderr).write(`${JSON.stringify({
    phase: contract.phase,
    warnings: audit.counts,
    elapsedMs: result.elapsedMs,
    childExitCode: result.exitCode,
  })}\n`)
  for (const error of audit.errors) (options.stderr ?? process.stderr).write(`${error}\n`)
  return audit.exitCode
}

export async function runCli(args, options = {}) {
  const index = args.indexOf("--contract")
  if (index < 0 || !args[index + 1]) throw new Error("usage: --contract <path>")
  const separator = args.indexOf("--")
  const vitestArgs = separator < 0 ? [] : args.slice(separator + 1)
  return runAudit(args[index + 1], { ...options, vitestArgs })
}

export async function runIfMain(metaUrl, argv1, args = process.argv.slice(2)) {
  if (argv1 && metaUrl === pathToFileURL(argv1).href) process.exitCode = await runCli(args)
}

await runIfMain(import.meta.url, process.argv[1])
