/**
 * Turn perf-artifacts/switch-events.json into a human-readable
 * perf-artifacts/switch-report.md. See plans/community-switch-perf-diagnosis.md.
 *
 * The correlation core (`analyzeSwitch`, `renderReport`) is pure and exported
 * for unit testing — no filesystem, no browser.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type {
  CaptureFile,
  CapturedSwitch,
  CapturedResource,
} from "../src/test/e2e-ui/perf/perf-capture-types"

const ARTIFACTS_DIR = resolve(import.meta.dirname, "..", "perf-artifacts")
const CAPTURE_IN = resolve(ARTIFACTS_DIR, "switch-events.json")
const REPORT_OUT = resolve(ARTIFACTS_DIR, "switch-report.md")

export function clearPerfArtifacts(capturePath = CAPTURE_IN, reportPath = REPORT_OUT): void {
  rmSync(capturePath, { force: true })
  rmSync(reportPath, { force: true })
}

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
  /** Total mount events reported by react-scan across all commits — INFLATED:
   * the ring buffer re-reports every still-mounted fiber on each subsequent
   * commit, so a single first-mount shows up once per later commit. */
  mountCountRaw: number
  /** Distinct fiber ids that mounted — the real "how many components first
   * mounted this switch". This is the trustworthy render-cost number. */
  mountCountUnique: number
  /** Total re-render events. Unlike mounts these are NOT inflated: each
   * (fiberId, commit, duration) triple is unique, so a fiber re-rendering N
   * times across N commits is N genuine renders. */
  rerenderCountRaw: number
  /** Distinct fiber ids that re-rendered at least once. */
  rerenderCountUnique: number
  unmounts: string[]
  topRenders: Array<{ name: string; count: number; reason?: string }>
  /** attribution of the perceived total. */
  verdict: string
}

function findResource(resources: CapturedResource[], needle: string): CapturedResource | undefined {
  return resources.find((r) => r.name.includes(needle))
}

/**
 * Count mount events two ways. react-scan's ring buffer re-reports every
 * still-mounted fiber on each subsequent commit, so `mountRaw` (the naive
 * total) is inflated 6-13× by that echo — an earlier heuristic tried to undo
 * it by "halving fibers seen an even number of times", but the real repeat
 * rate isn't 2× and that produced numbers ~3-4× too high. A first mount is
 * unique per fiber by definition, so deduping by fiberId is lossless and
 * yields the true count. Fibers without an id (rare) each count as their own
 * mount — they can't be deduped and dropping them would under-count.
 */
function countMounts(sw: CapturedSwitch): { mountRaw: number; mountUnique: number } {
  let mountRaw = 0
  const ids = new Set<number>()
  let idless = 0
  for (const commit of sw.commits) {
    for (const m of commit.mounts) {
      mountRaw++
      if (typeof m.fiberId === "number") ids.add(m.fiberId)
      else idless++
    }
  }
  return { mountRaw, mountUnique: ids.size + idless }
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

  const { mountRaw, mountUnique } = countMounts(sw)
  let rerenderCountRaw = 0
  const rerenderIds = new Set<number>()
  let rerenderIdless = 0
  const renderTally = new Map<string, { count: number; reason?: string }>()
  for (const commit of sw.commits) {
    for (const r of commit.rerenders) {
      rerenderCountRaw++
      if (typeof r.fiberId === "number") rerenderIds.add(r.fiberId)
      else rerenderIdless++
      const cur = renderTally.get(r.name) ?? { count: 0, reason: r.reason }
      cur.count++
      if (!cur.reason && r.reason) cur.reason = r.reason
      renderTally.set(r.name, cur)
    }
  }
  const rerenderCountUnique = rerenderIds.size + rerenderIdless
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
    verdict = `NOT network-bound — ${nonNetwork.toFixed(0)}ms of ${perceivedMs.toFixed(0)}ms is render/remount/reflow (network only ${networkMs.toFixed(0)}ms); mounts=${mountUnique} fibers, unmounts=${sw.unmounts.length}`
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
    mountCountUnique: mountUnique,
    rerenderCountRaw,
    rerenderCountUnique,
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
      "The headline is perceived latency (click → content stable). Counts are dev-mode. " +
      "Mounts are reported as `unique` (distinct fiber ids — the trustworthy number) and " +
      "`raw` (react-scan re-reports every still-mounted fiber on each later commit, inflating " +
      "the raw total 6-13×). Re-renders are NOT inflated (each is a genuine distinct render), " +
      "so `raw` is real; `unique` counts how many distinct components re-rendered.",
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
      `- renders: mounts ${a.mountCountUnique} unique (${a.mountCountRaw} raw w/ ring-buffer echo) · ` +
        `re-renders ${a.rerenderCountRaw} (${a.rerenderCountUnique} distinct components) · ` +
        `unmounts ${a.unmounts.length}`,
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
  if (process.argv.includes("--clear")) {
    clearPerfArtifacts()
    return
  }
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
