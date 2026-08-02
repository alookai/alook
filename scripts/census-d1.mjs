#!/usr/bin/env node
/**
 * C2-close census (PR-C3②-AST, Blondie / Aigneis). The predicate-INDEPENDENT
 * backstop that decides "D1-armor is complete" — run once at C2 close, NOT per
 * commit. baseline=0 only proves the hole-CLASSES we thought of are covered;
 * this directly enumerates every real D1 execution point and demands each has a
 * bucket. It uses the SAME `execPoints`/`enclosingCarrier` as the ratchet, so
 * its precision equals the ratchet's (Aigneis's backstop invariant — a coarser
 * census would carry the same blind spot it exists to catch).
 *
 * OUTPUT IS BUCKET-ANNOTATED, NOT binary (Aigneis #236): every execution point
 * is assigned to a bucket —
 *   armored          — inside a carrier closure
 *   baseline         — a deliberately-bare point tracked in the point baseline
 *                       (e.g. ws-durable.ts:1005 audit — benign, intentional)
 *   UNASSIGNED       — bare AND not in the baseline = a real blind spot
 * C2-DONE ⟺ zero UNASSIGNED points. A deliberately-bare point (baseline) stays
 * "bare" forever but is a known, decided exception — it does NOT block close.
 * Reporting only "diff empty/non-empty" would either declare C2 never-done (the
 * audit point keeps it non-empty) or pressure someone to armor a benign point
 * against the "deliberately not retried" ruling.
 *
 * SCOPE-SET — the whole D1-touching surface, empirically the 3 access modes
 * (barrel `queries.`, namespace-path import, direct handle), minus the leaf
 * query defs (`db/queries/**` — those are the retry UNITS; armor wraps at the
 * caller). ③ non-community D1 is out of this round's scope (documented).
 */
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { execPoints, pointKey } from "./lib/d1-ast.mjs"

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const BASELINE_PATH = "scripts/d1-armor-baseline.txt"

// ② community plane + workers + shared orchestration. ①=community routes,
// ②=community libs/middleware + ws-do + wake-worker + the shared wake-dispatch
// orchestration (thin worker entries delegate their real read into it).
// Predicates over a repo-relative path — the ② community/worker/orchestration
// plane, minus leaf query defs. Kept as path tests (not rg globs) so the census
// depends only on `git ls-files`, which is always present — `rg` is not (the
// dev box runs it as a shell function, CI images vary). AST `execPoints` finds
// the real D1 sites; we only need to hand it every .ts file in scope.
function inScope(f) {
  if (!f.endsWith(".ts") || f.endsWith(".test.ts")) return false
  if (f.includes("/db/queries/")) return false
  return (
    f.startsWith("src/web/src/app/api/community/") ||
    f.startsWith("src/web/src/lib/community/") ||
    (f.startsWith("src/web/src/lib/middleware/") && /(^|\/)community-/.test(f)) ||
    f.startsWith("src/ws-do/") ||
    f.startsWith("src/wake-worker/") ||
    f === "src/shared/src/community/wake-dispatch.ts"
  )
}

function scopeFiles() {
  const roots = [
    "src/web/src/app/api/community", "src/web/src/lib/community",
    "src/web/src/lib/middleware", "src/ws-do", "src/wake-worker",
    "src/shared/src/community",
  ]
  const out = execFileSync("git", ["ls-files", ...roots], { cwd: ROOT, encoding: "utf8" })
  const found = new Set(out.trim().split("\n").filter((f) => f && inScope(f)))
  return [...found].sort()
}

function readBaselineKeys() {
  if (!existsSync(`${ROOT}/${BASELINE_PATH}`)) return new Set()
  return new Set(
    readFileSync(`${ROOT}/${BASELINE_PATH}`, "utf8")
      .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
  )
}

const baseline = readBaselineKeys()
const buckets = { armored: [], intentionallyBare: [], baseline: [], UNASSIGNED: [] }

for (const file of scopeFiles()) {
  for (const p of execPoints(file, ROOT)) {
    // `d1BareAllowed({reason})` marks a documented deliberately-bare point — an
    // in-code, review-visible exception (Melly #260), not "armored".
    if (p.armored === "d1BareAllowed") buckets.intentionallyBare.push(p)
    else if (p.armored) buckets.armored.push(p)
    else if (baseline.has(pointKey(p))) buckets.baseline.push(p)
    else buckets.UNASSIGNED.push(p)
  }
}

const total =
  buckets.armored.length + buckets.intentionallyBare.length +
  buckets.baseline.length + buckets.UNASSIGNED.length
console.log(`D1 census — ${total} execution points across the ② scope:`)
console.log(`  armored (in a carrier):           ${buckets.armored.length}`)
console.log(`  intentionally-bare (d1BareAllowed): ${buckets.intentionallyBare.length}`)
for (const p of buckets.intentionallyBare) console.log(`      ${pointKey(p)}  ${p.kind}`)
console.log(`  baseline (grandfathered bare):    ${buckets.baseline.length}`)
for (const p of buckets.baseline) console.log(`      ${pointKey(p)}  ${p.kind}`)
console.log(`  UNATTRIBUTED (blind spot):        ${buckets.UNASSIGNED.length}`)
for (const p of buckets.UNASSIGNED) console.log(`      ${pointKey(p)}  ${p.kind}  ${p.text}`)

if (buckets.UNASSIGNED.length) {
  console.error(`\nC2 NOT done: ${buckets.UNASSIGNED.length} unassigned (bare, un-baselined) D1 point(s) — armor them or (if intentional) add to the point baseline with a documented reason.`)
  process.exit(1)
}
console.log(`\nC2 census clean: every D1 execution point is armored or a documented deliberately-bare baseline entry.`)
