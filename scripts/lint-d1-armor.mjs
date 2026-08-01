#!/usr/bin/env node
/**
 * Guardrail lint for D1-armor coverage on community route handlers (PR-C3①).
 *
 * Rule ① (this script): a community `route.ts` that calls `getDb()` must wrap
 * its D1 execution in a D1-armor carrier — `withD1Retry` / `readOrStale` /
 * `idempotentWrite` / `nonIdempotentWriteAllowed`. A bare `getDb()` route is a
 * new "unarmored D1 access" that a transient blip surfaces as a 500 (or, for a
 * fanout/enqueue read, a silent false-negative). Rule ② — the swallow-class
 * signature (a read whose result flows to fanout/enqueue inside a non-rethrow
 * catch) — needs data/control-flow analysis and lands separately as an ESLint
 * AST rule (C3b); a regex can't judge it without false results.
 *
 * RATCHET. 92 community routes were already bare when this landed; a hard rule
 * would fail them all at once and never land. So the pre-existing bare routes
 * are grandfathered in `scripts/d1-armor-baseline.txt` and this lint fails only
 * a NEW bare route. The baseline may only SHRINK (PR-C2 armors each route and
 * deletes its line); when it hits 0, C2 is done. Three checks enforce that:
 *
 *   A. Every currently-bare route MUST be listed in the baseline. A bare route
 *      not in the list = a newly-introduced unarmored route → fail.
 *   B. Every baseline entry MUST still be bare. A listed route that now has a
 *      carrier = a stale allowlist line → fail, demanding its removal (this is
 *      what makes C2's "armor + delete the line" the only green path).
 *   C. The baseline path count may not exceed the committed (HEAD) count. This
 *      mechanically blocks the "add a new bare route AND its baseline line in
 *      one diff" hole that A alone can't see — the ratchet is single-directional
 *      (Melly: mandatory, not review-eyeball).
 *
 * Excludes `*.test.ts`. Falls back to `git grep` when `rg` isn't on PATH.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const COMMUNITY_DIR = "src/web/src/app/api/community"
const BASELINE_PATH = "scripts/d1-armor-baseline.txt"
const CARRIERS = ["withD1Retry", "readOrStale", "idempotentWrite", "nonIdempotentWriteAllowed"]

/** Community `route.ts` files that reference `getDb` (excludes tests). */
function routesUsingGetDb() {
  const args = [
    "--type", "ts",
    "--glob", "!**/*.test.ts",
    "--glob", "**/route.ts",
    "--files-with-matches",
    "--no-heading",
    "--color", "never",
    "\\bgetDb\\b",
    COMMUNITY_DIR,
  ]
  try {
    const out = execFileSync("rg", args, { cwd: ROOT, encoding: "utf8" })
    return out.trim() ? out.trim().split("\n").sort() : []
  } catch (err) {
    if (err.status === 1 && !err.stderr?.toString().trim()) return []
    if (err.code === "ENOENT") return routesUsingGetDbGit()
    throw err
  }
}

function routesUsingGetDbGit() {
  const args = [
    "grep", "-l", "--no-color", "-P", "--",
    "\\bgetDb\\b",
    `:(glob)${COMMUNITY_DIR}/**/route.ts`,
    ":(exclude,glob)**/*.test.ts",
  ]
  try {
    const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
    return out.trim() ? out.trim().split("\n").sort() : []
  } catch (err) {
    if (err.status === 1) return []
    throw err
  }
}

/** A route is "armored" iff its own file references a carrier symbol. */
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

const bareRoutes = routesUsingGetDb().filter((p) => !isArmored(p))

if (!existsSync(`${ROOT}/${BASELINE_PATH}`)) {
  // Baseline fully burned down (C2 complete) → the ratchet is retired. Only a
  // bare route reintroduces the need for it.
  if (bareRoutes.length) {
    console.error(
      `lint-d1-armor: ${BASELINE_PATH} is gone (C2 done) but bare getDb routes exist again — wrap them in a D1-armor carrier:`,
    )
    for (const p of bareRoutes) console.error("  " + p)
    process.exit(1)
  }
  process.exit(0)
}

const baselineContent = readFileSync(`${ROOT}/${BASELINE_PATH}`, "utf8")
const baseline = readBaselinePaths(baselineContent)
const baselineSet = new Set(baseline)
const bareSet = new Set(bareRoutes)

let failed = false

// A. New bare route not grandfathered.
const newBare = bareRoutes.filter((p) => !baselineSet.has(p))
if (newBare.length) {
  failed = true
  console.error(
    "lint-d1-armor: NEW bare `getDb` community route(s) — wrap the D1 execution in a carrier (withD1Retry / readOrStale / idempotentWrite / nonIdempotentWriteAllowed). Do NOT add these to the baseline:",
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
