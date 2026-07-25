/**
 * Turn perf-artifacts/switch-events.json into a human-readable
 * perf-artifacts/switch-report.md. See plans/community-switch-perf-diagnosis.md.
 *
 * The correlation core (`analyzeSwitch`, `renderReport`) is pure and exported
 * for unit testing — no filesystem, no browser.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type {
  CaptureFile,
  CapturedSwitch,
  CapturedResource,
} from "../src/test/e2e-ui/perf/perf-capture-types"

const ARTIFACTS_DIR = resolve(import.meta.dirname, "..", "perf-artifacts")
const CAPTURE_IN = resolve(ARTIFACTS_DIR, "switch-events.json")
const REPORT_OUT = resolve(ARTIFACTS_DIR, "switch-report.md")

export interface SwitchAnalysis {
  kind: string
  targetId: string
  cacheState: string
  /** click → content-stable (or painted if no resize settle). The headline. */
  perceivedMs: number | null
  clickToSkeletonMs: number | null
  skeletonToPaintedMs: number | null
  paintedToStableMs: number | null
  /** sum of gaps where exactly one /api/community request was in flight. */
  networkMs: number
  /** wall time from first request start to last response end. */
  networkSpanMs: number
  /** true if read-state's response-end precedes messages' request-start. */
  readStateBlocksMessages: boolean | null
  mountCountRaw: number
  mountCountAdjusted: number
  rerenderCountRaw: number
  unmounts: string[]
  topRenders: Array<{ name: string; count: number; reason?: string }>
  /** attribution of the perceived total. */
  verdict: string
}

function findResource(resources: CapturedResource[], needle: string): CapturedResource | undefined {
  return resources.find((r) => r.name.includes(needle))
}

/**
 * Detect StrictMode double-commit inflation: in dev, the same logical fiber
 * (fiberId) mounts twice in immediate succession. We halve mount counts for
 * fiberIds seen exactly twice back-to-back.
 */
function adjustForStrictMode(sw: CapturedSwitch): { mountRaw: number; mountAdjusted: number } {
  const mountIds: number[] = []
  let mountRaw = 0
  for (const commit of sw.commits) {
    for (const m of commit.mounts) {
      mountRaw++
      if (typeof m.fiberId === "number") mountIds.push(m.fiberId)
    }
  }
  // Count fiberIds appearing an even number of times as StrictMode doubles.
  const seen = new Map<number, number>()
  for (const id of mountIds) seen.set(id, (seen.get(id) ?? 0) + 1)
  let doubled = 0
  for (const [, n] of seen) if (n >= 2) doubled += Math.floor(n / 2)
  const mountAdjusted = Math.max(mountRaw - doubled, 0)
  return { mountRaw, mountAdjusted }
}

export function analyzeSwitch(sw: CapturedSwitch): SwitchAnalysis {
  const clickToSkeletonMs = sw.skeletonTs != null ? sw.skeletonTs - sw.clickTs : null
  const skeletonToPaintedMs =
    sw.skeletonTs != null && sw.paintedTs != null ? sw.paintedTs - sw.skeletonTs : null
  const paintedToStableMs =
    sw.paintedTs != null && sw.contentStableTs != null ? sw.contentStableTs - sw.paintedTs : null
  const stableTs = sw.contentStableTs ?? sw.paintedTs
  const perceivedMs = stableTs != null ? stableTs - sw.clickTs : null

  const sorted = [...sw.resources].sort((a, b) => a.startTime - b.startTime)
  const networkSpanMs = sorted.length
    ? Math.max(...sorted.map((r) => r.responseEnd)) - Math.min(...sorted.map((r) => r.startTime))
    : 0
  // Union of busy intervals = actual time at least one request was in flight.
  let networkMs = 0
  let curStart = -1
  let curEnd = -1
  for (const r of sorted) {
    if (curEnd < r.startTime) {
      if (curStart >= 0) networkMs += curEnd - curStart
      curStart = r.startTime
      curEnd = r.responseEnd
    } else {
      curEnd = Math.max(curEnd, r.responseEnd)
    }
  }
  if (curStart >= 0) networkMs += curEnd - curStart

  const readState = findResource(sw.resources, "/read-state")
  const messages = findResource(sw.resources, "/messages")
  const readStateBlocksMessages =
    readState && messages ? readState.responseEnd <= messages.startTime + 1 : null

  const { mountRaw, mountAdjusted } = adjustForStrictMode(sw)
  let rerenderCountRaw = 0
  const renderTally = new Map<string, { count: number; reason?: string }>()
  for (const commit of sw.commits) {
    for (const r of commit.rerenders) {
      rerenderCountRaw++
      const cur = renderTally.get(r.name) ?? { count: 0, reason: r.reason }
      cur.count++
      if (!cur.reason && r.reason) cur.reason = r.reason
      renderTally.set(r.name, cur)
    }
  }
  const topRenders = [...renderTally.entries()]
    .map(([name, v]) => ({ name, count: v.count, reason: v.reason }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  // Attribution verdict.
  let verdict: string
  if (perceivedMs == null) {
    verdict = "incomplete capture — no content-stable anchor"
  } else if (networkMs >= perceivedMs * 0.6) {
    verdict =
      readStateBlocksMessages === true
        ? `network-bound, and read-state→messages is SERIALIZED (${networkMs.toFixed(0)}ms of ${perceivedMs.toFixed(0)}ms)`
        : `network-bound (${networkMs.toFixed(0)}ms of ${perceivedMs.toFixed(0)}ms)`
  } else {
    const nonNetwork = perceivedMs - networkMs
    verdict = `NOT network-bound — ${nonNetwork.toFixed(0)}ms of ${perceivedMs.toFixed(0)}ms is render/remount/reflow (network only ${networkMs.toFixed(0)}ms); remount=${mountAdjusted} fibers, unmounts=${sw.unmounts.length}`
  }

  return {
    kind: sw.kind,
    targetId: sw.targetId,
    cacheState: sw.cacheState,
    perceivedMs,
    clickToSkeletonMs,
    skeletonToPaintedMs,
    paintedToStableMs,
    networkMs,
    networkSpanMs,
    readStateBlocksMessages,
    mountCountRaw: mountRaw,
    mountCountAdjusted: mountAdjusted,
    rerenderCountRaw,
    unmounts: sw.unmounts,
    topRenders,
    verdict,
  }
}

function ms(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(0)}ms`
}

export function renderReport(file: CaptureFile): string {
  const lines: string[] = []
  lines.push("# Community Switch — Perceived-Latency Report")
  lines.push("")
  lines.push(`Owner: \`${file.owner.email}\` (userId \`${file.owner.userId}\`)`)
  lines.push(`Captured: ${file.createdAt}`)
  lines.push("")
  lines.push(
    "> Baseline: on local, network is ~0, so a visible loading spell is itself the anomaly. " +
      "The headline is perceived latency (click → content stable). Counts are dev-mode; " +
      "StrictMode-adjusted values remove the double-invoke inflation.",
  )
  lines.push("")

  for (const sw of file.switches) {
    const a = analyzeSwitch(sw)
    lines.push(`## ${a.kind} switch → \`${a.targetId}\`  _(cache: ${a.cacheState})_`)
    lines.push("")
    lines.push(`- PERCEIVED (click → content stable): **${ms(a.perceivedMs)}**`)
    lines.push(`  - click → skeleton: ${ms(a.clickToSkeletonMs)}`)
    lines.push(`  - skeleton → painted: ${ms(a.skeletonToPaintedMs)}`)
    lines.push(`  - painted → stable: ${ms(a.paintedToStableMs)}`)
    lines.push(
      `- network: ${ms(a.networkMs)} busy / ${ms(a.networkSpanMs)} span` +
        (a.readStateBlocksMessages == null
          ? ""
          : a.readStateBlocksMessages
            ? " · read-state→messages **SERIALIZED**"
            : " · read-state/messages overlap (parallel)"),
    )
    lines.push(
      `- renders: mounts ${a.mountCountRaw} raw / ${a.mountCountAdjusted} StrictMode-adjusted · re-renders ${a.rerenderCountRaw} · unmounts ${a.unmounts.length}`,
    )
    if (a.topRenders.length) {
      lines.push("- top re-renders:")
      for (const r of a.topRenders) {
        lines.push(`  - ${r.name} ×${r.count}${r.reason ? ` (${r.reason})` : ""}`)
      }
    }
    // network waterfall
    const sorted = [...sw.resources].sort((x, y) => x.startTime - y.startTime)
    if (sorted.length) {
      lines.push("- waterfall:")
      const base = sorted[0].startTime
      for (const r of sorted) {
        const short = r.name.replace(/^https?:\/\/[^/]+/, "").split("?")[0]
        lines.push(
          `  - ${short}  [t+${(r.startTime - base).toFixed(0)} → t+${(r.responseEnd - base).toFixed(0)}ms]`,
        )
      }
    }
    lines.push(`- **VERDICT:** ${a.verdict}`)
    lines.push("")
  }

  return lines.join("\n")
}

function main(): void {
  let file: CaptureFile
  try {
    file = JSON.parse(readFileSync(CAPTURE_IN, "utf8")) as CaptureFile
  } catch {
    console.error(`Missing ${CAPTURE_IN}. Run the perf spec first (pnpm perf:switch).`)
    process.exit(1)
  }
  const report = renderReport(file)
  writeFileSync(REPORT_OUT, report)
  console.log(`Wrote ${REPORT_OUT} (${file.switches.length} switches)`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
