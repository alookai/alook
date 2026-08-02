#!/usr/bin/env node
/**
 * Guardrail lint for D1-armor coverage on the COMMUNITY plane (PR-C3①ratchet;
 * scan extended to the route-plane libs + middleware per Aigneis #164 /
 * Blondie #166).
 *
 * A source file that opens a D1 handle (`getDb`) AND executes against it
 * (`db.batch(...)` / `await db.*` / a `queries.*` call) must wrap that D1
 * execution in a carrier — `withD1Retry` / `readOrStale` / `idempotentWrite` /
 * `nonIdempotentWriteAllowed`. A bare D1 execution is a transient-500 (or, for a
 * fanout/enqueue read, a silent false-negative) waiting to happen — the exact
 * class this whole effort removes.
 *
 * SCAN FACE — the community PLANE that opens its handle via `getDb`, not just
 * route.ts. `getDb` executes in these circles:
 *   ① community route handlers          (src/web/src/app/api/community/**\/route.ts)
 *   ② community-plane web libs + middleware (SCAN_DIRS below) ← extended here
 *
 * DELIBERATELY NOT scanned yet (each honest about WHY, so an unscanned layer is
 * never mistaken for a covered one — a silently-unscanned layer is a silently-
 * missed-delivery layer, the exact bug that motivated this extension):
 *   - The WORKER plane (src/ws-do, src/wake-worker) opens its handle via
 *     `createDb`, NOT `getDb` — this predicate would scan those dirs and match
 *     nothing, i.e. advertise coverage it does not deliver (Simone #195 / Melly
 *     #197). Folding them in needs the predicate to recognize `createDb` AND a
 *     line-level (not file-level) armor check — ws-durable.ts masks 37 bare
 *     `queries.` sites behind one `readOrStale`, which a file-level `isArmored`
 *     reads as fully armored. Deferred to the ws-do batch, where the predicate +
 *     granularity land together. Until then the C2 census (real `queries.`-call
 *     count, isArmored-blind) is the backstop that still catches those sites.
 *   - ③ non-community D1 (calendar/traces/conversations/non-community channels/
 *     machine-tokens/studio/auth+workspace middleware) — out of scope this
 *     round, tracked in a backlog ticket (Melly). ③'s auth-mw + machine-tokens
 *     are safety/credential reads flagged for priority evaluation.
 *
 * EXECUTION-POINT predicate (Blondie #166): match "getDb AND a D1 execution",
 * NOT bare `getDb`. A pure pass-through file (imports getDb, hands the handle
 * downstream, never executes) has NO D1 exit to armor; grandfathering it would
 * park a baseline line that can never burn → the "baseline hits 0 = done"
 * signal breaks. Routes almost always execute the handle they take, so ①'s
 * bare-getDb grep sufficed; ②'s libs/middleware pass through more often, so the
 * net tightens to real execution points.
 *
 * RATCHET. Pre-existing bare files are grandfathered in
 * `scripts/d1-armor-baseline.txt` and this lint fails only a NEW bare file. The
 * baseline may only SHRINK (each armor deletes its line); when it hits 0 the
 * plane is fully covered. Three checks enforce that:
 *   A. a currently-bare file not in the baseline → fail (new unarmored D1 exec).
 *   B. a baseline entry that is no longer bare → fail, demanding its removal.
 *   C. the baseline path count may not exceed the committed (HEAD) count →
 *      blocks "add a new bare file AND its baseline line in one diff".
 *
 * Excludes `*.test.ts`. Falls back to `git grep` when `rg` isn't on PATH.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const BASELINE_PATH = "scripts/d1-armor-baseline.txt"
const CARRIERS = ["withD1Retry", "readOrStale", "idempotentWrite", "nonIdempotentWriteAllowed"]

// The community plane reached via `getDb`. Each entry is a {dir, glob} the scan
// walks. A community route almost always executes the handle it opens, so
// route.ts files match on `getDb`; the lib/middleware layers pass through more,
// so they match only on `getDb` + an execution point (see hasD1Execution). The
// ws-do / wake-worker dirs are intentionally NOT here — they open via
// `createDb` and need the ws-do batch's predicate + line-level check (see the
// header's "DELIBERATELY NOT scanned yet").
const SCAN_DIRS = [
  { dir: "src/web/src/app/api/community", glob: "**/route.ts" },
  { dir: "src/web/src/lib/community", glob: "**/*.ts" },
  { dir: "src/web/src/lib/middleware", glob: "community-*.ts" },
]

// A file has a D1 EXECUTION point iff it runs a query against the handle —
// `db.batch(...)`, `await db.<method>(...)`, or a `queries.<ns>.<fn>(` call.
// A file that only `import { getDb }`s and passes the handle on does NOT.
const D1_EXEC_RE = /\bdb\.batch\(|\bawait\s+db\.|\bqueries\.[a-zA-Z]/

function fileHasGetDb(src) {
  return /\bgetDb\b/.test(src)
}
function hasD1Execution(src) {
  return D1_EXEC_RE.test(src)
}

/** All community-plane files that OPEN and EXECUTE a D1 handle (excludes tests). */
function filesWithD1Execution() {
  const found = new Set()
  for (const { dir, glob } of SCAN_DIRS) {
    for (const rel of listCandidateFiles(dir, glob)) {
      const src = readFileSync(`${ROOT}/${rel}`, "utf8")
      if (fileHasGetDb(src) && hasD1Execution(src)) found.add(rel)
    }
  }
  return [...found].sort()
}

/** Non-test .ts files under dir matching glob — rg with a git-grep fallback. */
function listCandidateFiles(dir, glob) {
  try {
    const out = execFileSync(
      "rg",
      [
        "--type", "ts",
        "--glob", "!**/*.test.ts",
        "--glob", glob,
        "--files-with-matches",
        "--no-heading",
        "--color", "never",
        "\\bgetDb\\b",
        dir,
      ],
      { cwd: ROOT, encoding: "utf8" },
    )
    return out.trim() ? out.trim().split("\n") : []
  } catch (err) {
    if (err.status === 1 && !err.stderr?.toString().trim()) return []
    if (err.code === "ENOENT") return listCandidateFilesGit(dir, glob)
    throw err
  }
}

function listCandidateFilesGit(dir, glob) {
  try {
    const out = execFileSync(
      "git",
      [
        "grep", "-l", "--no-color", "-P", "--",
        "\\bgetDb\\b",
        `:(glob)${dir}/${glob}`,
        ":(exclude,glob)**/*.test.ts",
      ],
      { cwd: ROOT, encoding: "utf8" },
    )
    return out.trim() ? out.trim().split("\n") : []
  } catch (err) {
    if (err.status === 1) return []
    throw err
  }
}

/** A file is "armored" iff it references a carrier symbol. */
function isArmored(relPath) {
  const src = readFileSync(`${ROOT}/${relPath}`, "utf8")
  return CARRIERS.some((c) => new RegExp(`\\b${c}\\b`).test(src))
}

/** Non-comment, non-blank baseline lines. */
function readBaselinePaths(content) {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .sort()
}

const bareFiles = filesWithD1Execution().filter((p) => !isArmored(p))

if (!existsSync(`${ROOT}/${BASELINE_PATH}`)) {
  // Baseline fully burned down (plane fully covered) → the ratchet is retired.
  // Only a bare file reintroduces the need for it.
  if (bareFiles.length) {
    console.error(
      `lint-d1-armor: ${BASELINE_PATH} is gone (plane fully armored) but bare D1-execution files exist again — wrap them in a D1-armor carrier:`,
    )
    for (const p of bareFiles) console.error("  " + p)
    process.exit(1)
  }
  process.exit(0)
}

const baselineContent = readFileSync(`${ROOT}/${BASELINE_PATH}`, "utf8")
const baseline = readBaselinePaths(baselineContent)
const baselineSet = new Set(baseline)
const bareSet = new Set(bareFiles)

let failed = false

// A. New bare file not grandfathered.
const newBare = bareFiles.filter((p) => !baselineSet.has(p))
if (newBare.length) {
  failed = true
  console.error(
    "lint-d1-armor: NEW bare community-plane D1-execution file(s) — wrap the D1 execution in a carrier (withD1Retry / readOrStale / idempotentWrite / nonIdempotentWriteAllowed). Do NOT add these to the baseline:",
  )
  for (const p of newBare) console.error("  " + p)
}

// B. Stale baseline entry (now armored, or file gone) → must be removed.
const stale = baseline.filter((p) => !bareSet.has(p))
if (stale.length) {
  failed = true
  console.error(
    `lint-d1-armor: baseline entr${stale.length === 1 ? "y is" : "ies are"} no longer bare (armored or removed) — delete ${stale.length === 1 ? "this line" : "these lines"} from ${BASELINE_PATH} (the ratchet only shrinks):`,
  )
  for (const p of stale) console.error("  " + p)
}

// C. Monotonic: the baseline may not have grown vs the committed (HEAD) version.
let headCount = null
try {
  const headContent = execFileSync("git", ["show", `HEAD:${BASELINE_PATH}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
  headCount = readBaselinePaths(headContent).length
} catch {
  // No committed baseline yet (first introduction) — nothing to compare against.
}
if (headCount !== null && baseline.length > headCount) {
  failed = true
  console.error(
    `lint-d1-armor: ${BASELINE_PATH} grew from ${headCount} to ${baseline.length} entries — the ratchet only shrinks. A new bare route must be armored, never added to the baseline.`,
  )
}

if (failed) process.exit(1)
