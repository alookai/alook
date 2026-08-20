import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PERF_SPEC = fileURLToPath(
  new URL("../e2e-ui/perf/switch.perf.ts", import.meta.url),
)
const source = readFileSync(PERF_SPEC, "utf8")

function sourceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

function expectOrdered(text: string, tokens: string[]): void {
  let cursor = -1
  for (const token of tokens) {
    const index = text.indexOf(token, cursor + 1)
    expect(index, `missing or out-of-order token: ${token}`).toBeGreaterThan(cursor)
    cursor = index
  }
}

describe("performance switch capture boundary", () => {
  it("passes both bounded waits through Playwright's third options argument", () => {
    const readiness = sourceBetween(
      "  // Prove the react-scan hook registered early enough:",
      "  const degraded =",
    )
    const measure = sourceBetween(
      "  async function measureSwitch(",
      "\n  function flushCapture",
    )

    expect(readiness).toMatch(
      /page\.waitForFunction\(\s*\(\) =>[\s\S]*?,\s*undefined,\s*\{ timeout: 20_000 \},\s*\)/,
    )
    expect(measure).toMatch(
      /\.waitForFunction\(\s*\(\{ kind, targetId, composerTestId \}\) =>[\s\S]*?,\s*\{ kind, targetId, composerTestId: tid\.composerInput \},\s*\{ timeout: 25_000 \},\s*\)/,
    )
    expect(source).toContain('import { tid } from "../_fixtures/testids"')
    expect(measure).not.toContain("community-composer-input")
  })

  it("replaces stale React events after readiness and immediately before navigation", () => {
    const readiness = "Array.isArray(window.__ALOOK_PERF__) && window.__ALOOK_PERF__.length > 0"
    const measureStart = "  async function measureSwitch("
    const measure = sourceBetween(measureStart, "\n  function flushCapture")

    expectOrdered(source, [readiness, measureStart])
    expect(measure).toMatch(
      /const markName = `alook:switch:\$\{kind\}:\$\{targetId\}`\s+const t0 = await page\.evaluate\(\(\) => \{\s+window\.__ALOOK_PERF__ = \[\]\s+return performance\.now\(\)\s+\}\)\s+await navigate\(\)/,
    )
    expect(measure).not.toMatch(/__ALOOK_PERF_(?:DEGRADED|INSTALLED|MARKS)__\s*=/)
  })

  it("disconnects and replaces resource and layout observers before capture", () => {
    const setup = sourceBetween("const INPAGE_SETUP = `", "\n`\n\ninterface DrainedSwitch")

    expectOrdered(setup, [
      "window.__PERF_RESOURCE_OBSERVER__.disconnect()",
      "window.__PERF_RESOURCES__ = []",
      "const ro = new PerformanceObserver",
      "window.__PERF_RESOURCE_OBSERVER__ = ro",
      "ro.observe({ type: 'resource', buffered: true })",
    ])
    expectOrdered(setup, [
      "window.__PERF_LAYOUT_OBSERVER__.disconnect()",
      "window.__PERF_SHIFTS__ = []",
      "const lo = new PerformanceObserver",
      "window.__PERF_LAYOUT_OBSERVER__ = lo",
      "lo.observe({ type: 'layout-shift', buffered: true })",
    ])
  })

  it("guards skeleton and asymmetric paint anchors with the measured route", () => {
    const measure = sourceBetween(
      "  async function measureSwitch(",
      "\n  function flushCapture",
    )

    expectOrdered(measure, [
      'const routeSegments = window.location.pathname.split("/").filter(Boolean)',
      "routeSegments.length === 4",
      'routeSegments[0] === "c"',
      'routeSegments[1] === "channels"',
      'routeSegments[3] === targetId',
      'routeSegments[2] === targetId',
      "if (!targetRoute) return false",
      "window.__PERF_SKELETON_TS__ = performance.now()",
      'const messageRow = document.querySelector("[data-msg-id]")',
      "const loadedEmptyHero = Array.from(",
      'startsWith("Beginning of the channel.")',
      "const composer = document.querySelector(",
      '`[data-testid="${composerTestId}"]`',
      "const painted =",
      'kind === "channel"',
      "? messageRow",
      ": messageRow || (loadedEmptyHero && composer)",
      "window.__PERF_PAINTED_TS__ = performance.now()",
    ])
    expect(measure).not.toMatch(
      /kind === "channel"[\s\S]*?loadedEmptyHero && composer[\s\S]*?\? messageRow/,
    )
  })

  it("preserves current-switch filtering, full fibers, settle, and incremental flush", () => {
    const drain = sourceBetween(
      "async function drainSwitch(",
      '\n\ntest("community switch perceived-latency capture"',
    )
    const measure = sourceBetween(
      "  async function measureSwitch(",
      "\n  function flushCapture",
    )

    expect(drain).toContain("filter((e) => e.ts >= clickTs)")
    expect(drain).toContain("const fibers = e.fibers || []")
    expect(drain).toContain("filter((r) => r.startTime >= clickTs)")
    expect(drain).toContain("filter((s) => s.ts >= clickTs)")
    expect(drain).not.toMatch(/events\.(?:slice|splice)\(/)
    expect(measure).toContain("await page.evaluate(() => window.__PERF_ATTACH_RESIZE__?.())")
    expect(measure).toContain("await page.waitForTimeout(600)")
    expect(measure).toContain("const drained = await drainSwitch(page, t0, markName)")
    expect(measure).toContain("flushCapture()")
  })
})
