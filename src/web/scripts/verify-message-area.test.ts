import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  evaluateStabilityThresholds,
  type StabilityScenarioMetrics,
} from "../src/test/e2e-ui/message-area-verify/stability-probe"
import {
  buildVerifySummary,
  findPlaywrightFfmpeg,
  parseVerifyArgs,
  type BrowserReport,
} from "./verify-message-area"

function scenario(overrides: Partial<StabilityScenarioMetrics> = {}): StabilityScenarioMetrics {
  return {
    scenario: "cached-text-switch-slow-reconcile",
    surface: "text",
    channelId: "ch_alpha",
    remountCount: 0,
    scrollerRemounts: 0,
    contentRemounts: 0,
    skeletonReappearanceCount: 0,
    skeletonMaskFrames: 0,
    maxRafVisibleRowShiftPx: 0.5,
    framesSampled: 90,
    topShifts: [],
    ...overrides,
  }
}

describe("verify-message-area helpers", () => {
  it("parses defaults and explicit flags", () => {
    const defaults = parseVerifyArgs([], "/work")
    expect(defaults).toEqual({
      mode: "baseline",
      browsers: ["chromium", "webkit"],
      outDir: resolve("/work", "test-results/message-area-verify"),
      reuseServer: false,
      allowMissingWebkit: false,
      fps: 20,
    })

    const custom = parseVerifyArgs(
      ["--mode", "assert", "--browsers", "webkit,chromium,webkit", "--out-dir", "out", "--reuse-server", "--fps", "24"],
      "/work",
    )
    expect(custom).toEqual({
      mode: "assert",
      browsers: ["webkit", "chromium"],
      outDir: resolve("/work", "out"),
      reuseServer: true,
      allowMissingWebkit: false,
      fps: 24,
    })
  })

  it("rejects invalid mode or browser values", () => {
    expect(() => parseVerifyArgs(["--mode", "invalid"])).toThrow(/Invalid --mode/)
    expect(() => parseVerifyArgs(["--browsers", "firefox"])).toThrow(/Invalid --browsers/)
  })

  it("evaluates stability thresholds against remount=0, skeleton=0, shift<=1px across message and forum surfaces", () => {
    expect(
      evaluateStabilityThresholds([
        scenario(),
        scenario({ scenario: "cached-forum-list-switch-and-tag-filter", surface: "forum-list" }),
        scenario({ scenario: "cached-forum-post-detail-split-slow-reconcile", surface: "forum-post" }),
      ]),
    ).toEqual({ passed: true, violations: [] })

    const failing = evaluateStabilityThresholds([
      scenario({
        scenario: "forum-split-parent-retention-on-post-switch",
        surface: "forum-list",
        remountCount: 1,
        skeletonReappearanceCount: 2,
        maxRafVisibleRowShiftPx: 14.25,
      }),
    ])
    expect(failing.passed).toBe(false)
    expect(failing.violations).toHaveLength(3)
    expect(failing.violations[0]).toContain("remountCount=1")
    expect(failing.violations[1]).toContain("skeletonReappearanceCount=2")
    expect(failing.violations[2]).toContain("maxRafVisibleRowShiftPx=14.25")
  })

  it("treats baseline summaries as recording-passing while assert summaries fail on violations or skipped browsers", () => {
    const failingReport: BrowserReport = {
      browser: "chromium",
      mode: "baseline",
      recordedAt: "2026-11-23T08:30:00.000Z",
      webmPath: "/tmp/a.webm",
      mp4Path: "/tmp/a.mp4",
      passed: false,
      violations: ["cached-text-switch-slow-reconcile: remountCount=1 (expected <= 0)"],
      scenarios: [scenario({ remountCount: 1 })],
    }
    expect(buildVerifySummary("baseline", [failingReport], []).passed).toBe(true)
    expect(buildVerifySummary("assert", [failingReport], []).passed).toBe(false)

    const passingReport: BrowserReport = {
      ...failingReport,
      mode: "assert",
      passed: true,
      violations: [],
      scenarios: [scenario()],
    }
    expect(
      buildVerifySummary("assert", [passingReport], [{ browser: "webkit", reason: "missing" }]).passed,
    ).toBe(false)
    expect(buildVerifySummary("assert", [passingReport], []).passed).toBe(true)
  })

  it("discovers the newest Playwright bundled ffmpeg binary from cache roots", () => {
    const root = mkdtempSync(join(tmpdir(), "pw-ffmpeg-test-"))
    try {
      mkdirSync(join(root, "ffmpeg-1010"), { recursive: true })
      mkdirSync(join(root, "ffmpeg-1013"), { recursive: true })
      writeFileSync(join(root, "ffmpeg-1010", "ffmpeg-mac"), "")
      writeFileSync(join(root, "ffmpeg-1013", "ffmpeg-mac"), "")
      expect(findPlaywrightFfmpeg([root])).toBe(join(root, "ffmpeg-1013", "ffmpeg-mac"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
