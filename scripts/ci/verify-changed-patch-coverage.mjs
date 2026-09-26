import { readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const REPOSITORY_ROUTING_GIT_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
]

export function isolatedRepositoryGitEnvironment(source = process.env) {
  const env = { ...source }
  for (const name of REPOSITORY_ROUTING_GIT_ENV) delete env[name]
  return env
}

function repositoryGit(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: isolatedRepositoryGitEnvironment(),
  })
}

function normalizedPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "")
}

export function parseAddedLines(diff) {
  const changed = new Map()
  let path = null
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      path = line === "+++ /dev/null" ? null : normalizedPath(line.slice(4).replace(/^b\//, ""))
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (!path || !hunk) continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    if (count === 0) continue
    const lines = changed.get(path) ?? new Set()
    for (let offset = 0; offset < count; offset += 1) lines.add(start + offset)
    changed.set(path, lines)
  }
  return changed
}

function reportPathForChangedFile(path, changedPaths, root) {
  const normalized = normalizedPath(path)
  const relativePath = isAbsolute(path) ? normalizedPath(relative(root, path)) : normalized
  if (changedPaths.has(relativePath)) return relativePath
  const matches = [...changedPaths].filter((candidate) => normalized.endsWith(`/${candidate}`))
  if (matches.length === 1) return matches[0]
  return null
}

function addCounter(lines, line, counter) {
  if (!Number.isInteger(line) || line < 1) return
  const entries = lines.get(line) ?? []
  entries.push(counter)
  lines.set(line, entries)
}

export function executableLineCounters(file) {
  const lines = new Map()
  for (const [id, location] of Object.entries(file.statementMap ?? {})) {
    addCounter(lines, location.start?.line, {
      kind: "statement",
      id,
      count: Number(file.s?.[id] ?? 0),
    })
  }
  for (const [id, fn] of Object.entries(file.fnMap ?? {})) {
    addCounter(lines, fn.loc?.start?.line, {
      kind: "function",
      id,
      count: Number(file.f?.[id] ?? 0),
    })
  }
  for (const [id, branch] of Object.entries(file.branchMap ?? {})) {
    branch.locations.forEach((location, arm) => {
      addCounter(lines, location.start?.line, {
        kind: "branch",
        id,
        arm,
        branchType: branch.type,
        count: Number(file.b?.[id]?.[arm] ?? 0),
      })
    })
  }
  return lines
}

export function collectChangedPatchCoverage(changedLines, report, options = {}) {
  const root = options.root ?? ROOT
  const changedPaths = new Set(changedLines.keys())
  const files = new Map()

  for (const [key, file] of Object.entries(report)) {
    const path = reportPathForChangedFile(file.path ?? key, changedPaths, root)
    if (!path) continue
    const changed = changedLines.get(path)
    const counters = executableLineCounters(file)
    const lines = files.get(path) ?? new Map()
    for (const line of changed) {
      const entries = counters.get(line)
      if (!entries) continue
      const current = lines.get(line) ?? []
      current.push(...entries)
      lines.set(line, current)
    }
    files.set(path, lines)
  }

  const fileResults = [...files]
    .map(([path, lines]) => {
      const details = [...lines]
        .sort(([left], [right]) => left - right)
        .map(([line, entries]) => ({
          line,
          covered: entries.some((entry) => entry.count > 0),
          entries,
        }))
      const missedLines = details.filter((detail) => !detail.covered).map((detail) => detail.line)
      return {
        path,
        covered: details.length - missedLines.length,
        missed: missedLines.length,
        total: details.length,
        missed_lines: missedLines,
        lines: details,
      }
    })
    .filter((file) => file.total > 0)
    .sort((left, right) => left.path.localeCompare(right.path))

  const totals = fileResults.reduce((sum, file) => ({
    covered: sum.covered + file.covered,
    missed: sum.missed + file.missed,
    total: sum.total + file.total,
  }), { covered: 0, missed: 0, total: 0 })

  return {
    covered_lines: totals.covered,
    missed_lines: totals.missed,
    total_lines: totals.total,
    percent: totals.total === 0 ? 100 : (totals.covered / totals.total) * 100,
    files: fileResults,
  }
}

function untrackedAddedLinesDiff(root) {
  const paths = repositoryGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])
  return paths.split("\0").filter(Boolean).map((path) => {
    const lineCount = readFileSync(resolve(root, path), "utf8").split("\n").length
    return [
      "--- /dev/null",
      `+++ b/${normalizedPath(path)}`,
      `@@ -0,0 +1,${lineCount} @@`,
    ].join("\n")
  }).join("\n")
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
  if (!args.base || !args.report) throw new Error("--base and --report are required")
  const root = resolve(args.root ?? ROOT)
  const head = args.head ?? "WORKTREE"
  const revisions = head === "WORKTREE" ? [args.base] : [args.base, head]
  const trackedDiff = repositoryGit(root, ["diff", "--unified=0", ...revisions, "--"])
  const diff = [
    trackedDiff,
    head === "WORKTREE" ? untrackedAddedLinesDiff(root) : "",
  ].filter(Boolean).join("\n")
  const report = JSON.parse(readFileSync(resolve(args.report), "utf8"))
  const result = collectChangedPatchCoverage(parseAddedLines(diff), report, { root })
  const output = `${JSON.stringify(result, null, 2)}\n`
  if (args.output) writeFileSync(resolve(args.output), output)
  process.stdout.write(
    `Changed patch coverage: ${result.covered_lines}/${result.total_lines} lines (${result.percent.toFixed(6)}%); ${result.missed_lines} missed.\n`,
  )
  for (const file of result.files.filter((entry) => entry.missed > 0)) {
    process.stdout.write(`${file.path}: ${file.missed_lines.join(", ")}\n`)
  }
  if (result.missed_lines > 0) {
    throw new Error(`changed patch has ${result.missed_lines} uncovered executable lines`)
  }
  return result
}

export function runIfMain(metaUrl, argvPath = process.argv[1], argv = process.argv.slice(2)) {
  if (argvPath === fileURLToPath(metaUrl)) runCli(argv)
}

runIfMain(import.meta.url)
