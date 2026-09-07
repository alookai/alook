import { readFileSync, readdirSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"

export const auditExitCode = 2
export const maxWallTimeMs = 1_500_000
export const rendererDeprecationPattern =
  "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer"

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

export function validateZeroAudit(inventory, output, elapsedMs, childExitCode) {
  const errors = []
  const mounts = inventory.reduce((total, entry) => total + entry.mounts, 0)
  const counts = countWarnings(output, {
    rendererDeprecation: rendererDeprecationPattern,
  })
  if (inventory.length !== 0) {
    errors.push(`renderer files: expected 0, received ${inventory.length}`)
  }
  if (mounts !== 0) {
    errors.push(`renderer mounts: expected 0, received ${mounts}`)
  }
  if (counts.rendererDeprecation !== 0) {
    errors.push(
      `rendererDeprecation warnings: expected 0, received ${counts.rendererDeprecation}`,
    )
  }
  if (elapsedMs > maxWallTimeMs) {
    errors.push(`wall time ${elapsedMs}ms exceeds ${maxWallTimeMs}ms`)
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

export async function runAudit(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? process.cwd()
  const inventory = scanRendererInventory(repositoryRoot)
  const inventoryAudit = validateZeroAudit(inventory, "", 0, 0)
  if (inventoryAudit.errors.length > 0) {
    for (const error of inventoryAudit.errors) {
      (options.stderr ?? process.stderr).write(`${error}\n`)
    }
    return auditExitCode
  }

  const result = await streamCommand(fullAuditCommand(options.vitestArgs), {
    ...options,
    cwd: repositoryRoot,
  })
  const audit = validateZeroAudit(inventory, result.output, result.elapsedMs, result.exitCode)
  ;(options.stderr ?? process.stderr).write(`${JSON.stringify({
    phase: "zero",
    warnings: audit.counts,
    elapsedMs: result.elapsedMs,
    childExitCode: result.exitCode,
  })}\n`)
  for (const error of audit.errors) (options.stderr ?? process.stderr).write(`${error}\n`)
  return audit.exitCode
}

export async function runCli(args, options = {}) {
  const separator = args.indexOf("--")
  const vitestArgs = separator < 0 ? [] : args.slice(separator + 1)
  return runAudit({ ...options, vitestArgs })
}

export async function runIfMain(metaUrl, argv1, args = process.argv.slice(2)) {
  if (argv1 && metaUrl === pathToFileURL(argv1).href) process.exitCode = await runCli(args)
}

await runIfMain(import.meta.url, process.argv[1])
