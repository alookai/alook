import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const BLOG_CONTENT = /^src\/web\/src\/content\/[^/]+\.mdx$/
const BLOG_ASSET = /^src\/web\/public\/blog(?:\/|$)/
const MARKDOWN = /(?:^|\/)\w[^/]*\.md$/i
const WORKFLOW = /^\.github\/workflows\//
const GLOBAL_PATHS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "vitest.config.ts",
])
const KNOWN_ROOTS = [
  ".claude/",
  ".openai/",
  "docs/",
  "src/app/",
  "src/cli/",
  "src/daemon/",
  "src/desktop/",
  "src/email-worker/",
  "src/shared/",
  "src/wake-worker/",
  "src/web/",
  "src/ws-do/",
  "tests/integration/cli/",
  "tests/integration/daemon/",
  "tests/utils/",
]

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "")
}

function isBlogPath(path) {
  return BLOG_CONTENT.test(path) || BLOG_ASSET.test(path)
}

function isMarkdownPath(path) {
  return MARKDOWN.test(path)
}

function isKnownPath(path) {
  return (
    isMarkdownPath(path) ||
    isBlogPath(path) ||
    GLOBAL_PATHS.has(path) ||
    KNOWN_ROOTS.some((root) => path.startsWith(root))
  )
}

export function classifyPaths(inputPaths, options = {}) {
  const paths = [...new Set(inputPaths.map(normalizePath).filter(Boolean))].sort()
  const empty = paths.length === 0
  const docsOnly = !empty && paths.every(isMarkdownPath)
  const blogOnly = !empty && paths.every(isBlogPath)
  const contentMix =
    !docsOnly && !blogOnly && paths.every((path) => isMarkdownPath(path) || isBlogPath(path))
  const workflowChanged = paths.some((path) => WORKFLOW.test(path))
  const globalChanged = paths.some(
    (path) =>
      GLOBAL_PATHS.has(path) ||
      path.startsWith("scripts/") ||
      (path.startsWith(".github/") && !isMarkdownPath(path))
  )
  const unknownChanged = paths.some((path) => !isKnownPath(path))
  const forceFull = options.forceFull === true
  const full = empty || forceFull || contentMix || workflowChanged || globalChanged || unknownChanged
  const effectiveDocsOnly = docsOnly && !full
  const effectiveBlogOnly = blogOnly && !full
  const web = full || paths.some((path) => path.startsWith("src/web/"))
  const shared = full || paths.some((path) => path.startsWith("src/shared/"))
  const cli = full || paths.some((path) => path.startsWith("src/cli/"))
  const daemon = full || paths.some((path) => path.startsWith("src/daemon/"))
  const desktop = full || paths.some((path) => path.startsWith("src/desktop/"))
  const wsDo = full || paths.some((path) => path.startsWith("src/ws-do/"))
  const worker =
    full ||
    paths.some(
      (path) =>
        path.startsWith("src/email-worker/") ||
        path.startsWith("src/wake-worker/") ||
        path.startsWith("src/ws-do/")
    )
  const app = full || paths.some((path) => path.startsWith("src/app/"))
  const integration = full || paths.some((path) => path.startsWith("tests/integration/"))
  const codeChanged =
    full || paths.some((path) => !isMarkdownPath(path) && !isBlogPath(path))
  const runCodeChecks = codeChanged && !effectiveBlogOnly && !effectiveDocsOnly

  return {
    paths,
    full,
    docs_only: effectiveDocsOnly,
    blog_only: effectiveBlogOnly,
    workflow_changed: workflowChanged,
    run_code_checks: runCodeChecks,
    run_windows: runCodeChecks && (full || cli || daemon || shared),
    run_e2e: runCodeChecks && (full || web || shared || cli || daemon || worker || integration),
    run_ui_e2e: !effectiveBlogOnly && runCodeChecks && (full || web || shared || wsDo),
    run_rust: runCodeChecks && (full || desktop),
    run_lighthouse: runCodeChecks && (full || web),
    run_knip: runCodeChecks && (full || app || cli || shared || web || worker),
  }
}

export function parseNameStatus(buffer) {
  const fields = buffer.toString("utf8").split("\0")
  const paths = []
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]
    if (!status) continue
    const firstPath = fields[index++]
    if (firstPath) paths.push(firstPath)
    if (status.startsWith("R") || status.startsWith("C")) {
      const secondPath = fields[index++]
      if (secondPath) paths.push(secondPath)
    }
  }
  return paths
}

function readChangedPaths(args) {
  if (args.forceFull) return []
  if (args.pathsFile) {
    return readFileSync(resolve(args.pathsFile), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
  }
  if (!args.base || !args.head) {
    throw new Error("Both --base and --head are required")
  }
  const diff = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", `${args.base}...${args.head}`],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  return parseNameStatus(diff)
}

function parseArgs(argv) {
  const args = { forceFull: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--force-full") {
      args.forceFull = true
      continue
    }
    const key = arg.replace(/^--/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    args[key] = argv[++index]
  }
  return args
}

function writeOutputs(path, result) {
  const output = Object.entries(result)
    .filter(([key]) => key !== "paths")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\n")
  appendFileSync(path, `${output}\n`)
}

function writeSummary(path, result, fallbackReason) {
  const flags = Object.entries(result)
    .filter(([key]) => key !== "paths")
    .map(([key, value]) => `| \`${key}\` | \`${value}\` |`)
    .join("\n")
  const changed = result.paths.map((item) => `- \`${item}\``).join("\n") || "- none"
  const fallback = fallbackReason ? `\nFail-closed reason: ${fallbackReason}\n` : ""
  appendFileSync(
    path,
    `## CI scope\n${fallback}\n| Output | Value |\n| --- | --- |\n${flags}\n\n<details><summary>Changed paths</summary>\n\n${changed}\n\n</details>\n`
  )
}

export function runCli(argv) {
  const args = parseArgs(argv)
  let result
  let fallbackReason = ""
  try {
    result = classifyPaths(readChangedPaths(args), { forceFull: args.forceFull })
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error)
    result = classifyPaths([], { forceFull: true })
  }
  if (args.output) writeOutputs(args.output, result)
  if (args.summary) writeSummary(args.summary, result, fallbackReason)
  if (!args.output) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
}
