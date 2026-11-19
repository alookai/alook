import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Page, Request, TestInfo } from "@playwright/test"
import type { CaseActors } from "./case-fixture"
import { REPO_ROOT } from "../_setup/paths"
import {
  READING_DIAGNOSTIC_ENUMS, READING_DIAGNOSTIC_IDENTITY_KEYS, READING_DIAGNOSTIC_REFERENCE_KEYS,
  READING_DIAGNOSTIC_STAGES, READING_DIAGNOSTIC_VALUE_KEYS,
  type ReadingDiagnosticFields, type ReadingDiagnosticRecord, type ReadingDiagnosticSnapshot, type ReadingDiagnosticStage,
} from "@/lib/community/message-reading-diagnostic"

type CollectorOptions = {
  limit: number
  stages: readonly string[]
  enums: readonly string[]
  values: readonly string[]
  identities: readonly string[]
  refs: readonly string[]
}

export function installMessageReadingCollector(options: CollectorOptions): void {
  if (window.top !== window || window.__alookMessageReadingDiagnostic) return
  const stages = new Set(options.stages), enums = new Set(options.enums), valueKeys = new Set(options.values)
  const identityKeys = new Set(options.identities), referenceKeys = new Set(options.refs)
  const records: Array<ReadingDiagnosticRecord | undefined> = []
  const pending = new Set<Promise<void>>()
  const references = new WeakMap<object, Promise<string | null>>()
  let active = true, invoked = 0, dropped = 0, rejected = 0, hashErrors = 0, sourceErrors = 0, afterStop = 0, referenceCount = 0
  const salt = `${performance.timeOrigin}:${window.crypto.randomUUID()}`
  const hash = async (value: string): Promise<string | null> => {
    try {
      const result = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
      return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, "0")).join("")
    } catch { hashErrors++; return null }
  }
  const documentHash = hash(`document:${salt}`)
  const reference = (value: object) => {
    let existing = references.get(value)
    if (!existing) { existing = hash(`reference:${salt}:${++referenceCount}`); references.set(value, existing) }
    return existing
  }
  const sink: NonNullable<Window["__alookMessageReadingDiagnostic"]> = {
    failure: () => { sourceErrors++ },
    record: (stage, fields) => {
      if (!active) { afterStop++; return }
      const sequence = invoked++
      if (!stages.has(stage)) { rejected++; return }
      if (records.length >= options.limit) { dropped++; return }
      const index = records.length
      records.push(undefined)
      const pageNow = performance.now(), epochMs = Date.now(), timeOrigin = performance.timeOrigin
      const values: ReadingDiagnosticRecord["values"] = {}
      for (const [key, value] of Object.entries(fields.values ?? {})) {
        if (value === undefined) continue
        if (!valueKeys.has(key) || !(value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)
          || typeof value === "string" && enums.has(value))) { rejected++; continue }
        values[key] = value
      }
      const identities = Object.entries(fields.identities ?? {}).flatMap(([key, value]) => {
        if (value === undefined) return []
        if (!identityKeys.has(key) || value !== null && (typeof value !== "string" || value.length > 65536)) { rejected++; return [] }
        return [[key, value] as const]
      })
      const refs = Object.entries(fields.refs ?? {}).flatMap(([key, value]) => {
        if (value === undefined) return []
        if (!referenceKeys.has(key) || value !== null && (typeof value !== "object" && typeof value !== "function")) { rejected++; return [] }
        return [[key, value] as const]
      })
      const operation = (async () => {
        const hashes = Object.fromEntries(await Promise.all(identities.map(async ([key, value]) => [key, value === null ? null : await hash(value)])))
        const refHashes = Object.fromEntries(await Promise.all(refs.map(async ([key, value]) => [key, value === null ? null : await reference(value)])))
        const doc = await documentHash
        records[index] = { sequence, stage, pageNow, epochMs, timeOrigin, documentHash: doc, values, hashes, refs: refHashes,
          hashFailure: doc === null || identities.some(([key, value]) => value !== null && hashes[key] === null)
            || refs.some(([key, value]) => value !== null && refHashes[key] === null) }
      })().catch(() => { sourceErrors++ }).finally(() => { pending.delete(operation) })
      pending.add(operation)
    },
    snapshot: async (stop = false) => {
      if (stop) active = false
      await Promise.allSettled([...pending])
      return { records: records.filter((record): record is ReadingDiagnosticRecord => !!record), active, pending: pending.size,
        invoked, dropped, rejected, hashErrors, sourceErrors, afterStop }
    },
  }
  window.__alookMessageReadingDiagnostic = sink
  sink.record("collector.start", {})
}

const collectorOptions: CollectorOptions = {
  limit: 50000, stages: READING_DIAGNOSTIC_STAGES, enums: READING_DIAGNOSTIC_ENUMS, values: READING_DIAGNOSTIC_VALUE_KEYS,
  identities: READING_DIAGNOSTIC_IDENTITY_KEYS, refs: READING_DIAGNOSTIC_REFERENCE_KEYS,
}

type NodeRecord = {
  sequence: number
  stage: ReadingDiagnosticStage
  nodeNow: number
  epochMs: number
  timeOrigin: number
  navigationCount: number
  previousStage: ReadingDiagnosticStage | null
  values: Record<string, number | boolean | string | null>
  hashes: Record<string, string | null>
  refs: Record<string, string | null>
}

export type MessageReadingCapture = {
  record: (stage: ReadingDiagnosticStage, fields: ReadingDiagnosticFields, request?: Request) => void
}

export async function captureMessageReading(actors: CaseActors, page: Page, info: TestInfo): Promise<MessageReadingCapture | undefined> {
  if (process.env.ALOOK_READING_DIAGNOSTIC !== "1"
    || !/^dm (desktop|narrow) fast preserves reading across two real pages in both directions$/.test(info.title)) return
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const rows: NodeRecord[] = [], references = new WeakMap<object, string>()
  const requestStages = new WeakMap<Request, ReadingDiagnosticStage>()
  let referenceCount = 0, sequence = 0, navigationCount = 0, dropped = 0, rejected = 0, sourceErrors = 0
  let phaseNavigation: number | undefined
  const stages = new Set<string>(READING_DIAGNOSTIC_STAGES), enums = new Set<string>(READING_DIAGNOSTIC_ENUMS)
  const valueKeys = new Set<string>(READING_DIAGNOSTIC_VALUE_KEYS), identityKeys = new Set<string>(READING_DIAGNOSTIC_IDENTITY_KEYS)
  const referenceKeys = new Set<string>(READING_DIAGNOSTIC_REFERENCE_KEYS)
  const reference = (value: object) => {
    let existing = references.get(value)
    if (!existing) { existing = hash(`node-reference:${++referenceCount}`); references.set(value, existing) }
    return existing
  }
  const record: MessageReadingCapture["record"] = (stage, fields, request) => {
    try {
      if (!stages.has(stage)) { rejected++; return }
      const ordinal = sequence++
      if (rows.length >= collectorOptions.limit) { dropped++; return }
      const nodeNow = performance.now(), epochMs = Date.now(), timeOrigin = performance.timeOrigin
      const values: NodeRecord["values"] = {}, hashes: NodeRecord["hashes"] = {}, refs: NodeRecord["refs"] = {}
      for (const [key, value] of Object.entries(fields.values ?? {})) {
        if (value === undefined) continue
        if (!valueKeys.has(key) || !(value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)
          || typeof value === "string" && enums.has(value))) { rejected++; continue }
        values[key] = value
      }
      for (const [key, value] of Object.entries(fields.identities ?? {})) {
        if (value === undefined) continue
        if (!identityKeys.has(key) || value !== null && (typeof value !== "string" || value.length > 65536)) { rejected++; continue }
        hashes[key] = value === null ? null : hash(value)
      }
      for (const [key, value] of Object.entries(fields.refs ?? {})) {
        if (value === undefined) continue
        if (!referenceKeys.has(key) || value !== null && typeof value !== "object" && typeof value !== "function") { rejected++; continue }
        refs[key] = value === null ? null : reference(value)
      }
      if (request) refs.nodeRequest = reference(request)
      const previousStage = request ? requestStages.get(request) ?? null : null
      rows.push({ sequence: ordinal, stage, nodeNow, epochMs, timeOrigin, navigationCount, previousStage, values, hashes, refs })
      if (request) requestStages.set(request, stage)
      if (stage === "phase.start" && phaseNavigation === undefined) phaseNavigation = navigationCount
    } catch { sourceErrors++ }
  }
  const onNavigation = (request: Request) => {
    try {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return
      navigationCount++
      record("document.navigation", { values: { navigationCount } })
    } catch { sourceErrors++ }
  }
  page.on("request", onNavigation)
  try {
    await page.addInitScript(installMessageReadingCollector, collectorOptions)
    await page.evaluate(installMessageReadingCollector, collectorOptions)
  } catch { sourceErrors++ }
  const root = REPO_ROOT
  const inputPaths = [
    "src/web/src/lib/community/message-reading-diagnostic.ts", "src/web/src/test/e2e-ui/_fixtures/message-reading-diagnostic.ts",
    "src/web/src/hooks/community/use-scroll-anchor.ts", "src/web/src/hooks/community/use-messages.ts",
    "src/web/src/hooks/community/use-virtual-cursor-pagination.ts", "src/web/src/components/community/messages/message-list-controller.ts",
    "src/web/src/lib/community/message-window.ts", "src/web/src/test/e2e-ui/55-history-reading-continuity.spec.ts",
  ]
  let input: { caseHash: string; sourceCommit: string; lockHash: string; files: Array<{ path: string; sha256: string }> } | null = null
  try {
    input = { caseHash: hash(info.title), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      lockHash: hash(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8")),
      files: inputPaths.map(path => ({ path, sha256: hash(readFileSync(resolve(root, path), "utf8")) })) }
  } catch { sourceErrors++ }
  actors.onCleanup(async () => {
    const cleanupNodeNow = performance.now(), cleanupEpochMs = Date.now()
    let browser: ReadingDiagnosticSnapshot | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!page.isClosed()) browser = await Promise.race([
        page.evaluate(async () => {
          const sink = window.__alookMessageReadingDiagnostic
          if (!sink) return null
          const snapshot = await sink.snapshot(true)
          delete window.__alookMessageReadingDiagnostic
          return snapshot
        }),
        new Promise<null>(resolve => { timer = setTimeout(() => { sourceErrors++; resolve(null) }, 2000) }),
      ])
    } catch { sourceErrors++ } finally { clearTimeout(timer) }
    page.off("request", onNavigation)
    const phaseNavigationUnchanged = phaseNavigation !== undefined && phaseNavigation === navigationCount
    const collectionComplete = !!input && !!browser && !browser.active && browser.pending === 0 && browser.dropped === 0 && browser.rejected === 0
      && browser.hashErrors === 0 && browser.sourceErrors === 0 && dropped === 0 && rejected === 0 && sourceErrors === 0 && phaseNavigationUnchanged
    const stageCounts = Object.fromEntries(READING_DIAGNOSTIC_STAGES.map(stage => [stage,
      (browser?.records.filter(record => record.stage === stage).length ?? 0) + rows.filter(record => record.stage === stage).length]))
    const requiredBoundaryCoverage = ["surface.bind", "controller.bind", "pagination.gate", "reading.reconcile", "observer.cleanup"]
      .every(stage => stageCounts[stage] > 0)
    await info.attach("message-reading-diagnostic.safe.json", { contentType: "application/json", body: JSON.stringify({
      input, complete: collectionComplete && requiredBoundaryCoverage, collectionComplete, requiredBoundaryCoverage, stageCounts, browser,
      cleanup: { nodeNow: cleanupNodeNow, epochMs: cleanupEpochMs, caseStatus: info.status ?? "unknown" },
      node: { records: rows, dropped, rejected, sourceErrors, navigationCount, phaseNavigation, phaseNavigationUnchanged, pageClosed: page.isClosed() },
      scope: "Current main document only; prior navigation documents are not retained. Records continue through cleanup: join the original native failed-call end before attributing any later state to failure. Original native outcome and diagnostic completeness are separate.",
      clocks: "pageNow and nodeNow are distinct monotonic domains; epochMs/timeOrigin are calibration observations, not interchangeable callback clocks.",
    }) })
  })
  return { record }
}
