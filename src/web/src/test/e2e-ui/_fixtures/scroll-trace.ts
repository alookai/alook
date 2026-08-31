import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Page, TestInfo } from "@playwright/test"

export const SCROLL_TRACE_SCHEMA_VERSION = 1
export const SCROLL_TRACE_PROFILE_VERSION = "message-scroll-v1"
const repoRoot = existsSync(resolve(process.cwd(), "pnpm-lock.yaml"))
  ? process.cwd()
  : resolve(process.cwd(), "../..")
export const SCROLL_TRACE_PROBE_PATH = resolve(
  repoRoot,
  "src/web/src/test/e2e-ui/_fixtures/scroll-trace-browser.js",
)

export type ScrollTraceStatus = "stable" | "settlementTimedOut"
export type ScrollTraceDataSource =
  | "initial-cold"
  | "initial-cache"
  | "older-page"
  | "newer-page"
  | "anchor-swap"
  | "overlay-ws"
  | "optimistic-send"
  | "post-ack"
  | "ws-dedupe"

export interface ScrollTraceIdentity {
  sourceSha: string
  lockHash: string
  servedBuildId: string
  probeHash: string
  profileVersion: string
  runtime: string
  account: string
  channel: string
  viewport: { width: number; height: number; dpr: number }
}

export interface ScrollTraceRect {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

export interface ScrollTraceRow {
  index: number
  id: string
  top: number
  bottom: number
  height: number
  estimatedHeight: number | null
  visible: boolean
}

export interface ScrollTraceFrame {
  frame: number
  timestamp: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  browserMax: number
  distanceToEnd: number
  programmaticScrollInProgress: boolean
  scrollerRect: ScrollTraceRect | null
  contentRect: ScrollTraceRect | null
  composerRect: ScrollTraceRect | null
  accessoryRailRect: ScrollTraceRect | null
  tailGap: number | null
  newDividerRect: ScrollTraceRect | null
  loaders: {
    top: { mounted: boolean; loading: boolean; rect: ScrollTraceRect | null }
    bottom: { mounted: boolean; loading: boolean; rect: ScrollTraceRect | null }
  }
  pill: { mode: "jump" | "scroll" | null; count: number; label: string | null }
  renderedRange: [number, number] | null
  visibleRange: [number, number] | null
  firstVisibleId: string | null
  firstVisibleOffset: number | null
  lastVisibleId: string | null
  domIds: string[]
  rows: ScrollTraceRow[]
  mark: string
  writerRevision: number
  measurementRevision: number
}

export interface ScrollTraceWrite {
  timestamp: number
  frame: number
  method: string
  args: unknown[]
  mark: string
  fingerprint: string
  stack: string
}

export interface ScrollTraceMark {
  timestamp: number
  frame: number
  name: string
  dataTransitionSource: ScrollTraceDataSource | null
  detail: unknown
  preEventDistanceToEnd: number
  programmaticScrollInProgress: boolean
}

export interface ScrollTraceResult {
  schemaVersion: number
  scenario: string
  commandDirection: "forward" | "backward" | null
  identity: ScrollTraceIdentity
  startedAt: number
  endedAt: number
  status: ScrollTraceStatus
  capabilities: Record<string, { supported: boolean; descriptor: unknown }>
  marks: ScrollTraceMark[]
  frames: ScrollTraceFrame[]
  writes: ScrollTraceWrite[]
  measurements: Array<{
    timestamp: number
    frame: number
    id: string | null
    index: number | null
    height: number
  }>
  externalEvents: Array<{ timestamp: number; type: string; detail: unknown }>
  dropped: { frames: number; writes: number }
}

export interface ScrollTraceSummary {
  scenario: string
  status: ScrollTraceStatus
  frameCount: number
  settlementFrames: number
  finalProgress: number
  reversalCount: number
  maxReversalPx: number
  zeroProgressFrames: number
  frameDelta: { p50: number; p95: number; max: number }
  anchorDriftPx: number | null
  tailGapDriftPx: number | null
  writerCount: number
  contentionEpochs: Array<{ frame: number; owners: string[] }>
  unknownWriterCount: number
  measurementCount: number
  repeatedMeasurementRows: Array<{ id: string; count: number }>
  estimateErrorPx: { p50: number; p95: number; max: number } | null
}

type BrowserTraceApi = {
  schemaVersion: number
  selfTest: () => unknown
  start: (options: unknown) => Promise<unknown>
  mark: (name: string, detail?: unknown) => unknown
  finish: () => Promise<ScrollTraceResult>
  abort: () => void
}

export function readScrollTraceProbe(): { source: string; hash: string } {
  const source = readFileSync(SCROLL_TRACE_PROBE_PATH, "utf8")
  return { source, hash: createHash("sha256").update(source).digest("hex") }
}

export function createScrollTraceIdentity(input: {
  account: string
  channel: string
  runtime?: string
  servedBuildId?: string
  viewport: { width: number; height: number; dpr?: number }
}): ScrollTraceIdentity {
  const sourceSha = process.env.GITHUB_SHA
    ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()
  const lockHash = createHash("sha256")
    .update(readFileSync(resolve(repoRoot, "pnpm-lock.yaml")))
    .digest("hex")
  const probeHash = readScrollTraceProbe().hash
  return {
    sourceSha,
    lockHash,
    servedBuildId: input.servedBuildId
      ?? process.env.ALOOK_TRACE_BUILD_ID
      ?? `${sourceSha}:${lockHash.slice(0, 16)}`,
    probeHash,
    profileVersion: SCROLL_TRACE_PROFILE_VERSION,
    runtime: input.runtime ?? "chromium",
    account: input.account,
    channel: input.channel,
    viewport: {
      ...input.viewport,
      dpr: input.viewport.dpr ?? 1,
    },
  }
}

export async function installScrollTrace(page: Page): Promise<{ probeHash: string }> {
  const probe = readScrollTraceProbe()
  await page.addInitScript({ content: probe.source })
  return { probeHash: probe.hash }
}

export async function installScrollTraceInCurrentDocument(page: Page): Promise<{ probeHash: string }> {
  const probe = readScrollTraceProbe()
  await page.addScriptTag({ content: probe.source })
  return { probeHash: probe.hash }
}

export async function scrollTraceSelfTest(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const api = (globalThis as typeof globalThis & { __alookScrollTrace?: BrowserTraceApi })
      .__alookScrollTrace
    if (!api) throw new Error("scroll trace probe is not installed")
    return api.selfTest()
  })
}

export async function startScrollTrace(page: Page, input: {
  scenario: string
  identity: ScrollTraceIdentity
  commandDirection?: "forward" | "backward"
  estimatedSizes?: Record<string, number>
  maxFrames?: number
}): Promise<unknown> {
  return page.evaluate((options) => {
    const api = (globalThis as typeof globalThis & { __alookScrollTrace?: BrowserTraceApi })
      .__alookScrollTrace
    if (!api) throw new Error("scroll trace probe is not installed")
    return api.start({
      scrollerTestId: "community-message-scroller",
      settlementTimeoutMs: 2000,
      settlementFrameCap: 120,
      maxFrames: 2400,
      ...options,
    })
  }, input)
}

export async function markScrollTrace(
  page: Page,
  name: string,
  input?: { dataTransitionSource?: ScrollTraceDataSource; detail?: unknown },
): Promise<ScrollTraceMark> {
  return page.evaluate(
    ({ mark, detail }) => {
      const api = (globalThis as typeof globalThis & { __alookScrollTrace?: BrowserTraceApi })
        .__alookScrollTrace
      if (!api) throw new Error("scroll trace probe is not installed")
      return api.mark(mark, detail) as ScrollTraceMark
    },
    { mark: name, detail: input },
  )
}

export async function finishScrollTrace(page: Page): Promise<ScrollTraceResult> {
  return page.evaluate(() => {
    const api = (globalThis as typeof globalThis & { __alookScrollTrace?: BrowserTraceApi })
      .__alookScrollTrace
    if (!api) throw new Error("scroll trace probe is not installed")
    return api.finish()
  })
}

export async function abortScrollTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (globalThis as typeof globalThis & { __alookScrollTrace?: BrowserTraceApi })
      .__alookScrollTrace
    api?.abort()
  }).catch(() => {})
}

export async function attachScrollTrace(
  testInfo: TestInfo,
  result: ScrollTraceResult,
): Promise<ScrollTraceSummary> {
  const validation = validateScrollTrace(result)
  if (validation.length > 0) throw new Error(`invalid scroll trace: ${validation.join("; ")}`)
  const summary = summarizeScrollTrace(result)
  await testInfo.attach(`${result.scenario}.scroll-trace.json`, {
    body: Buffer.from(JSON.stringify(result)),
    contentType: "application/json",
  })
  await testInfo.attach(`${result.scenario}.scroll-summary.json`, {
    body: Buffer.from(JSON.stringify(summary)),
    contentType: "application/json",
  })
  return summary
}

export function validateScrollTrace(result: ScrollTraceResult): string[] {
  const errors: string[] = []
  if (result.schemaVersion !== SCROLL_TRACE_SCHEMA_VERSION) errors.push("schema version")
  if (!result.scenario) errors.push("scenario")
  if (!result.identity?.sourceSha || !result.identity.lockHash || !result.identity.probeHash) {
    errors.push("identity")
  }
  if (result.status !== "stable" && result.status !== "settlementTimedOut") errors.push("status")
  if (!result.marks.some((mark) => mark.name === "final-stimulus")) errors.push("final-stimulus mark")
  let timestamp = -Infinity
  for (const frame of result.frames) {
    if (frame.timestamp < timestamp) errors.push("non-monotonic timestamp")
    timestamp = frame.timestamp
    for (const value of [
      frame.scrollTop,
      frame.scrollHeight,
      frame.clientHeight,
      frame.browserMax,
      frame.distanceToEnd,
    ]) {
      if (!Number.isFinite(value)) errors.push("non-finite geometry")
    }
  }
  const serialized = JSON.stringify(result)
  if (/cookie|authorization|set-cookie|better-auth/i.test(serialized)) errors.push("sensitive field")
  return [...new Set(errors)]
}

export function inferWriterOwner(write: ScrollTraceWrite): string {
  const stack = write.stack.toLowerCase()
  if (stack.includes("virtual-core") || stack.includes("tanstack")) return "tanstack-virtual"
  if (stack.includes("use-scroll-anchor")) return "scroll-anchor"
  if (stack.includes("message-list-controller")) return "selection-clearance"
  if (stack.includes("scroll-trace")) return "test-stimulus"
  return `unknown:${write.fingerprint}`
}

export function coalesceWriterCalls(writes: ScrollTraceWrite[]): Array<{
  owner: string
  firstFrame: number
  lastFrame: number
  calls: ScrollTraceWrite[]
}> {
  const epochs: Array<{
    owner: string
    firstFrame: number
    lastFrame: number
    calls: ScrollTraceWrite[]
  }> = []
  for (const write of writes) {
    const owner = inferWriterOwner(write)
    const previous = epochs.at(-1)
    if (previous && previous.owner === owner && write.frame - previous.lastFrame <= 1) {
      previous.lastFrame = write.frame
      previous.calls.push(write)
    } else {
      epochs.push({ owner, firstFrame: write.frame, lastFrame: write.frame, calls: [write] })
    }
  }
  return epochs
}

function percentile(values: number[], value: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)]!
}

export function summarizeScrollTrace(result: ScrollTraceResult): ScrollTraceSummary {
  const finalMark = result.marks.find((mark) => mark.name === "final-stimulus")
  const finalFrames = finalMark
    ? result.frames.filter((frame) => frame.frame >= finalMark.frame)
    : result.frames
  const deltas = finalFrames.slice(1).map((frame, index) =>
    frame.scrollTop - finalFrames[index]!.scrollTop)
  const absoluteDeltas = deltas.map(Math.abs)
  const direction = result.commandDirection === "backward" ? -1 : 1
  const reversals = deltas.filter((delta) => delta * direction < -4)
  const epochs = coalesceWriterCalls(result.writes)
  const ownersByFrame = new Map<number, Set<string>>()
  for (const epoch of epochs) {
    for (let frame = epoch.firstFrame; frame <= epoch.lastFrame; frame += 1) {
      const owners = ownersByFrame.get(frame) ?? new Set<string>()
      owners.add(epoch.owner)
      ownersByFrame.set(frame, owners)
    }
  }
  const contentionEpochs = [...ownersByFrame.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([frame, owners]) => ({ frame, owners: [...owners].sort() }))
  const measurementCounts = new Map<string, number>()
  for (const measurement of result.measurements) {
    if (!measurement.id) continue
    measurementCounts.set(measurement.id, (measurementCounts.get(measurement.id) ?? 0) + 1)
  }
  const finalRows = result.frames.at(-1)?.rows ?? []
  const estimateErrors = finalRows.flatMap((row) => row.estimatedHeight === null
    ? []
    : [Math.abs(row.height - row.estimatedHeight)])
  const first = finalFrames[0]
  const last = finalFrames.at(-1)
  const matchingAnchor = first && last && first.firstVisibleId === last.firstVisibleId
  return {
    scenario: result.scenario,
    status: result.status,
    frameCount: result.frames.length,
    settlementFrames: finalFrames.length,
    finalProgress: first && last ? last.scrollTop - first.scrollTop : 0,
    reversalCount: reversals.length,
    maxReversalPx: reversals.length ? Math.max(...reversals.map(Math.abs)) : 0,
    zeroProgressFrames: deltas.filter((delta) => Math.abs(delta) < 0.01).length,
    frameDelta: {
      p50: percentile(absoluteDeltas, 0.5),
      p95: percentile(absoluteDeltas, 0.95),
      max: absoluteDeltas.length ? Math.max(...absoluteDeltas) : 0,
    },
    anchorDriftPx: matchingAnchor && first.firstVisibleOffset !== null && last.firstVisibleOffset !== null
      ? last.firstVisibleOffset - first.firstVisibleOffset
      : null,
    tailGapDriftPx: first?.tailGap !== null && first?.tailGap !== undefined && last?.tailGap !== null && last?.tailGap !== undefined
      ? last.tailGap - first.tailGap
      : null,
    writerCount: result.writes.length,
    contentionEpochs,
    unknownWriterCount: epochs.filter((epoch) => epoch.owner.startsWith("unknown:"))
      .reduce((count, epoch) => count + epoch.calls.length, 0),
    measurementCount: result.measurements.length,
    repeatedMeasurementRows: [...measurementCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id, count]) => ({ id, count }))
      .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id)),
    estimateErrorPx: estimateErrors.length ? {
      p50: percentile(estimateErrors, 0.5),
      p95: percentile(estimateErrors, 0.95),
      max: Math.max(...estimateErrors),
    } : null,
  }
}

export function nativeMargin(
  observed: number,
  unit: "css-px" | "count" | "ms" | "percentage-point",
): number {
  if (unit === "percentage-point") return Math.max(0.1, Math.abs(observed) * 0.05)
  if (unit === "count") return Math.max(1, Math.ceil(Math.abs(observed) * 0.05))
  return Math.max(1, Math.abs(observed) * 0.05)
}

export function classifyTracePair(
  web: ScrollTraceResult,
  desktop: ScrollTraceResult,
): { classification: "matched" | "platform-regression" | "unclassified"; reasons: string[] } {
  const reasons: string[] = []
  for (const key of [
    "sourceSha",
    "lockHash",
    "servedBuildId",
    "probeHash",
    "profileVersion",
    "account",
    "channel",
  ] as const) {
    if (web.identity[key] !== desktop.identity[key]) reasons.push(`identity:${key}`)
  }
  for (const key of ["width", "height", "dpr"] as const) {
    if (web.identity.viewport[key] !== desktop.identity.viewport[key]) reasons.push(`viewport:${key}`)
  }
  if (web.scenario !== desktop.scenario) reasons.push("scenario")
  if (reasons.length > 0) return { classification: "unclassified", reasons }
  const webSummary = summarizeScrollTrace(web)
  const desktopSummary = summarizeScrollTrace(desktop)
  const reversalLimit = webSummary.reversalCount + nativeMargin(webSummary.reversalCount, "count")
  const driftBaseline = Math.abs(webSummary.anchorDriftPx ?? 0)
  const driftLimit = driftBaseline + nativeMargin(driftBaseline, "css-px")
  if (
    desktopSummary.reversalCount > reversalLimit
    || Math.abs(desktopSummary.anchorDriftPx ?? 0) > driftLimit
  ) {
    return { classification: "platform-regression", reasons: ["matched identity with larger Desktop drift"] }
  }
  return { classification: "matched", reasons: [] }
}
