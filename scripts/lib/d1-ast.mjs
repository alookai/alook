#!/usr/bin/env node
/**
 * Shared TS-AST analyzer for the D1-armor guardrails (PR-C3②-AST, Blondie).
 *
 * ONE traverser, three consumers — point-level ratchet (`lint-d1-armor.mjs`),
 * swallow-class lint (`lint-d1-swallow.mjs`), and the C2-close census
 * (`census-d1.mjs`). They MUST share this module so the census's precision
 * equals the ratchet's — a backstop that judged points more coarsely than the
 * guard it backstops would carry the same blind spot (Aigneis's invariant). The
 * grep version could not do point-level: carriers wrap MULTI-LINE closures
 * (`withD1Retry(async () => { …queries.x(db)… })`), so a line-window "is a
 * carrier near this queries. line" test false-positives every armored point in
 * a closure as bare (proven on batch-A: permissions.ts:163/164/166 under one
 * withD1Retry, enrich's 6 reads under one). Only an AST ancestor walk answers
 * "is THIS execution point inside a carrier call's closure".
 *
 * Two primitives:
 *   execPoints(file)      → the D1 execution points in a file (a D1 op runs here)
 *   enclosingCarrier(node) → the carrier call this node sits inside, or null
 *
 * D1 EXECUTION POINT (first-arg-db predicate, Blondie): a call is a D1 exit iff
 *   - `queries.<ns>.<fn>(db, …)` — a query-layer call whose FIRST ARG is a db
 *     handle. First-arg-db is the DEFINITION of "touches D1", not a patch: a
 *     `queries.*`-namespaced helper that takes no db (hashCredential = pure
 *     SHA, doNameFromHash / toSummary = pure transforms) does not execute D1
 *     and is correctly NOT a point — no allowlist needed.
 *   - `db.batch(…)` / `await db.<verb>(…)` — direct handle execution.
 * The db handle is recognized by name: an arg / receiver whose leftmost
 * identifier is `db` (the codebase convention — every query fn takes `db`
 * first, every direct exec is on a `db` local). `createDb(…)`/`getDb(…)` only
 * OPEN a handle (not an exec point themselves); the exec is the later call.
 */
import ts from "typescript"
import { readFileSync } from "node:fs"

export const CARRIERS = ["withD1Retry", "readOrStale", "idempotentWrite", "nonIdempotentWriteAllowed"]

// `d1BareAllowed({ reason })` — a no-op marker wrapping a point that is
// DELIBERATELY left un-armored (Melly #260): a transient-tolerant read whose
// loss self-heals with no wrong-state (e.g. a typing fan-out read). Same spirit
// as `nonIdempotentWriteAllowed({reason})` — the decision + reason live IN THE
// CODE, machine-detectable, review-visible — never a side-list (a side-list is
// human memory = the blind spot this whole effort removes). `enclosingCarrier`
// reports it distinctly so the census buckets it as "intentionally-bare" (a
// documented, non-blocking exception) rather than "armored" or "UNATTRIBUTED".
export const BARE_MARKER = "d1BareAllowed"

/** Leftmost identifier of a (possibly nested) property-access / call chain. */
function rootIdentifier(node) {
  let cur = node
  while (cur) {
    if (ts.isIdentifier(cur)) return cur.text
    if (ts.isPropertyAccessExpression(cur)) cur = cur.expression
    else if (ts.isCallExpression(cur)) cur = cur.expression
    else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) cur = cur.expression
    else return null
  }
  return null
}

/** Does this expression denote the D1 handle? (`db`, `this.db`, `ctx.db`, …) */
function isDbHandleExpr(arg) {
  if (!arg) return false
  if (ts.isIdentifier(arg)) return arg.text === "db"
  if (ts.isPropertyAccessExpression(arg)) return arg.name.text === "db"
  return false
}

/**
 * Classify a CallExpression as a D1 execution point, or null.
 *  - "queries" : `queries.<ns>.<fn>(db, …)`
 *  - "db"      : `db.<verb>(…)` (incl. `.batch(`) on the handle
 */
function classifyCall(call) {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return null

  // queries.<ns>.<fn>(db, …) — root identifier is `queries`, first arg is db.
  if (rootIdentifier(callee) === "queries") {
    return isDbHandleExpr(call.arguments[0]) ? "queries" : null
  }

  // db.<verb>(…) — the call receiver is the db handle itself
  // (`db.batch(...)`, `await db.select()...`, `db.insert()...`).
  if (isDbHandleExpr(callee.expression)) return "db"

  return null
}

/** The carrier call `node` sits inside (as a descendant of its arguments), or null. */
export function enclosingCarrier(node) {
  let cur = node.parent
  while (cur) {
    if (ts.isCallExpression(cur)) {
      const name = ts.isIdentifier(cur.expression)
        ? cur.expression.text
        : ts.isPropertyAccessExpression(cur.expression)
          ? cur.expression.name.text
          : null
      if ((name && CARRIERS.includes(name)) || name === BARE_MARKER) {
        // Confirm `node` is within the carrier's ARGUMENTS (its wrapped
        // closure), not merely a later sibling that shares an ancestor.
        if (cur.arguments.some((a) => a.pos <= node.pos && node.end <= a.end)) {
          return name
        }
      }
    }
    cur = cur.parent
  }
  return null
}

/**
 * All D1 execution points in one file.
 * @returns {{file:string, line:number, kind:"queries"|"db", armored:string|null, text:string}[]}
 */
export function execPoints(relPath, root) {
  const abs = `${root}/${relPath}`
  const src = readFileSync(abs, "utf8")
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true)
  const points = []

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const kind = classifyCall(node)
      if (kind) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        points.push({
          file: relPath,
          line: line + 1, // 1-indexed
          kind,
          armored: enclosingCarrier(node),
          text: node.getText(sf).split("\n")[0].slice(0, 80),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return points
}

/** `file:line` key for a point (baseline entries use this form). */
export function pointKey(p) {
  return `${p.file}:${p.line}`
}
