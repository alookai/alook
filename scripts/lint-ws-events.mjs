#!/usr/bin/env node
/**
 * Guardrail lint for community WS events.
 *
 * 1. `type: "community:*"` hardcoded literals under
 *    `src/web/src/app/api/community` — should be `WS_EVENTS.*` from
 *    `@alook/shared` so a rename fires a typecheck error at the send site.
 *
 * 2. `as never` inside any `broadcastToUser*` / `fanOutTo*` call under
 *    `src/web/src` — defeats the discriminated `CommunityWsEvent` union.
 *
 * Excludes `*.test.ts` so tests can still assert against raw strings.
 * Falls back to `git grep` when `rg` isn't on PATH (rare, but keeps hooks
 * portable).
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "")

// Catch every hand-written `community:*` event string, in each form it
// appears at a send or dispatch site:
//   - `type: "community:..."`  — payload construction
//   - `case "community:..."`   — client dispatch switch arms
//   - `=== / !== / == "community:..."` — event-type comparisons
// All three should route through `WS_EVENTS.*` from `@alook/shared` so a
// rename fires a typecheck error at the use site instead of drifting silently.
const PATTERN_LITERAL =
  '[!=]==?\\s*"community:|case\\s+"community:|type:\\s*"community:'
const LITERAL_PATHS = [
  "src/web/src/app/api/community",
  "src/web/src/hooks/community",
  "src/ws-do/src",
]

// Files whose `community:*` literals are NOT WS event names and must not be
// flagged. `rate-limits.ts` keys its policy map on `"community:msgSend"` — a
// rate-limit name, not a broadcast event.
const LITERAL_WHITELIST = ["src/shared/src/lib/rate-limits.ts"]

const PATTERN_AS_NEVER =
  "(broadcastToUser(?:Safe)?|fanOutToChannel|fanOutToDM|fanOutToServerMembers)\\([^)]*as never"
const AS_NEVER_PATHS = ["src/web/src"]

function runRg(pattern, paths, { multiline = false } = {}) {
  const args = [
    "--type", "ts",
    "--glob", "!**/*.test.ts",
    "--line-number",
    "--no-heading",
    "--color", "never",
  ]
  if (multiline) args.push("-U", "--multiline")
  args.push(pattern, ...paths)
  try {
    const out = execFileSync("rg", args, { cwd: ROOT, encoding: "utf8" })
    return out.trim() ? out.trim().split("\n") : []
  } catch (err) {
    // rg exits 1 when there are no matches — treat as empty.
    if (err.status === 1 && !err.stderr?.toString().trim()) return []
    // rg not found — fall back to git grep.
    if (err.code === "ENOENT") return runGitGrep(pattern, paths, { multiline })
    throw err
  }
}

function runGitGrep(pattern, paths, { multiline = false } = {}) {
  const pathspecs = [
    ...paths.map((p) => `:(glob)${p}/**/*.ts`),
    ":(exclude,glob)**/*.test.ts",
  ]
  if (!multiline) {
    const args = ["grep", "-nP", "--no-color", "--", pattern, ...pathspecs]
    try {
      const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
      return out.trim() ? out.trim().split("\n") : []
    } catch (err) {
      if (err.status === 1) return []
      throw err
    }
  }
  // Multiline fallback: list candidate files with `git ls-files`, read each,
  // and match the pattern across the whole file. Returns `file:line` for the
  // start of each match.
  const filesRaw = execFileSync(
    "git",
    ["ls-files", "-z", "--", ...pathspecs],
    { cwd: ROOT, encoding: "utf8" },
  )
  const files = filesRaw
    .split("\0")
    .filter(Boolean)
    // Belt-and-braces: some git versions ignore the `:(exclude,glob)` pathspec
    // when it's paired with a `:(glob)` include, so filter test files here too.
    .filter((rel) => !/\.test\.ts$/.test(rel))
  const rx = new RegExp(pattern, "gs")
  const results = []
  for (const rel of files) {
    const full = `${ROOT}/${rel}`
    const src = readFileSync(full, "utf8")
    for (const m of src.matchAll(rx)) {
      const before = src.slice(0, m.index)
      const line = before.split("\n").length
      const snippet = m[0].split("\n")[0]
      results.push(`${rel}:${line}:${snippet}`)
    }
  }
  return results
}



const literalMatches = runRg(PATTERN_LITERAL, LITERAL_PATHS).filter(
  (line) => !LITERAL_WHITELIST.some((p) => line.startsWith(p)),
)
const castMatches = runRg(PATTERN_AS_NEVER, AS_NEVER_PATHS, { multiline: true })

let failed = false

if (literalMatches.length) {
  failed = true
  console.error(
    'lint-ws-events: hardcoded `type: "community:*"` literals — use WS_EVENTS.* from @alook/shared:',
  )
  for (const line of literalMatches) console.error("  " + line)
}

if (castMatches.length) {
  failed = true
  console.error(
    "lint-ws-events: `as never` inside a broadcast/fan-out call — the CommunityWsEvent union should type it directly:",
  )
  for (const line of castMatches) console.error("  " + line)
}

if (failed) process.exit(1)
