import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, webkit } from "@playwright/test"
import {
  evaluateStabilityThresholds,
  type StabilityScenarioMetrics,
} from "../src/test/e2e-ui/message-area-verify/stability-probe"

export type VerifyMode = "baseline" | "assert"
export type VerifyBrowser = "chromium" | "webkit"

export type VerifyCliOptions = Readonly<{
  mode: VerifyMode
  browsers: readonly VerifyBrowser[]
  outDir: string
  reuseServer: boolean
  allowMissingWebkit: boolean
  fps: number
}>

export type BrowserReport = Readonly<{
  browser: VerifyBrowser
  mode: VerifyMode
  recordedAt: string
  webmPath: string | null
  mp4Path?: string | null
  videoConverter?: "system-ffmpeg" | "playwright-ffmpeg+macos-swift" | "webm-only"
  passed: boolean
  violations: readonly string[]
  scenarios: readonly StabilityScenarioMetrics[]
}>

export type VerifySummary = Readonly<{
  mode: VerifyMode
  generatedAt: string
  passed: boolean
  browsers: readonly BrowserReport[]
  skippedBrowsers: readonly { browser: VerifyBrowser; reason: string }[]
}>

export function parseVerifyArgs(argv: readonly string[], cwd = process.cwd()): VerifyCliOptions {
  let mode: VerifyMode = "baseline"
  let browsers: VerifyBrowser[] = ["chromium", "webkit"]
  let outDir = resolve(cwd, "test-results/message-area-verify")
  let reuseServer = false
  let allowMissingWebkit = false
  let fps = 20

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token === "--mode") {
      const value = argv[++index]
      if (value !== "baseline" && value !== "assert") {
        throw new Error(`Invalid --mode value: ${String(value)} (expected baseline or assert)`)
      }
      mode = value
    } else if (token === "--browsers") {
      const value = argv[++index] ?? ""
      const parsed = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
      if (parsed.length === 0 || parsed.some((entry) => entry !== "chromium" && entry !== "webkit")) {
        throw new Error(`Invalid --browsers value: ${value} (expected chromium,webkit)`)
      }
      browsers = [...new Set(parsed as VerifyBrowser[])]
    } else if (token === "--out-dir") {
      const value = argv[++index]
      if (!value) throw new Error("--out-dir requires a path")
      outDir = resolve(cwd, value)
    } else if (token === "--reuse-server") {
      reuseServer = true
    } else if (token === "--allow-missing-webkit") {
      allowMissingWebkit = true
    } else if (token === "--fps") {
      const value = Number(argv[++index])
      if (!Number.isInteger(value) || value < 5 || value > 60) {
        throw new Error(`Invalid --fps value: ${String(value)} (expected integer 5..60)`)
      }
      fps = value
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }

  return { mode, browsers, outDir, reuseServer, allowMissingWebkit, fps }
}

export function findPlaywrightFfmpeg(
  cacheRoots: readonly string[] = [
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
  ],
): string | null {
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue
    const entries = readdirSync(root)
      .filter((entry) => entry.startsWith("ffmpeg-"))
      .sort()
      .reverse()
    for (const entry of entries) {
      for (const candidate of ["ffmpeg-mac", "ffmpeg-linux", "ffmpeg-win64.exe"]) {
        const full = join(root, entry, candidate)
        if (existsSync(full)) return full
      }
    }
  }
  return null
}

function resolveSystemBinary(name: string): string | null {
  const probe = spawnSync("which", [name], { encoding: "utf8" })
  if (probe.status !== 0) return null
  const resolved = probe.stdout.trim()
  return resolved.length > 0 ? resolved : null
}

const MACOS_SWIFT_PNG_TO_MP4 = `
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

let args = CommandLine.arguments
guard args.count >= 4 else { exit(2) }
let framesDir = URL(fileURLWithPath: args[1], isDirectory: true)
let outputUrl = URL(fileURLWithPath: args[2])
let fps = Int32(args[3]) ?? 20

let files = try FileManager.default
  .contentsOfDirectory(at: framesDir, includingPropertiesForKeys: nil)
  .filter { $0.pathExtension.lowercased() == "png" }
  .sorted { $0.lastPathComponent < $1.lastPathComponent }

guard let firstUrl = files.first,
      let firstSource = CGImageSourceCreateWithURL(firstUrl as CFURL, nil),
      let firstImage = CGImageSourceCreateImageAtIndex(firstSource, 0, nil) else {
  exit(3)
}

let width = firstImage.width
let height = firstImage.height
try? FileManager.default.removeItem(at: outputUrl)

let writer = try AVAssetWriter(outputURL: outputUrl, fileType: .mp4)
let settings: [String: Any] = [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: width,
  AVVideoHeightKey: height,
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
  assetWriterInput: input,
  sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32ARGB),
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
  ]
)
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

let colorSpace = CGColorSpaceCreateDeviceRGB()
var frameIndex: Int64 = 0
for url in files {
  autoreleasepool {
    while !input.isReadyForMoreMediaData {
      Thread.sleep(forTimeInterval: 0.005)
    }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil),
          let pool = adaptor.pixelBufferPool else {
      return
    }
    var pixelBuffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer)
    guard let buffer = pixelBuffer else { return }
    CVPixelBufferLockBaseAddress(buffer, [])
    if let ctx = CGContext(
      data: CVPixelBufferGetBaseAddress(buffer),
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
    ) {
      ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    adaptor.append(buffer, withPresentationTime: CMTime(value: frameIndex, timescale: fps))
    frameIndex += 1
  }
}

input.markAsFinished()
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
if writer.status != .completed {
  fputs("AVAssetWriter failed: \\(writer.error?.localizedDescription ?? "unknown")\\n", stderr)
  exit(4)
}
`

export function convertWebmToMp4(
  webmPath: string,
  mp4Path: string,
  fps: number,
): { mp4Path: string | null; converter: "system-ffmpeg" | "playwright-ffmpeg+macos-swift" | "webm-only" } {
  const systemFfmpeg = resolveSystemBinary("ffmpeg")
  if (systemFfmpeg) {
    execFileSync(
      systemFfmpeg,
      [
        "-y",
        "-i",
        webmPath,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        mp4Path,
      ],
      { stdio: "inherit" },
    )
    return { mp4Path, converter: "system-ffmpeg" }
  }

  const pwFfmpeg = findPlaywrightFfmpeg()
  const systemSwift = process.platform === "darwin" ? resolveSystemBinary("swift") : null
  if (pwFfmpeg && systemSwift) {
    const framesDir = join(tmpdir(), `alook-mp4-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(framesDir, { recursive: true })
    try {
      execFileSync(
        pwFfmpeg,
        ["-y", "-i", webmPath, "-r", String(fps), join(framesDir, "frame_%05d.png")],
        { stdio: "inherit" },
      )
      const swiftResult = spawnSync(
        systemSwift,
        ["-", framesDir, mp4Path, String(fps)],
        { input: MACOS_SWIFT_PNG_TO_MP4, stdio: ["pipe", "inherit", "inherit"] },
      )
      if (swiftResult.status !== 0) {
        throw new Error(`Swift MP4 encoder exited with status ${String(swiftResult.status)}`)
      }
      return { mp4Path, converter: "playwright-ffmpeg+macos-swift" }
    } finally {
      rmSync(framesDir, { recursive: true, force: true })
    }
  }

  return { mp4Path: null, converter: "webm-only" }
}

export function buildVerifySummary(
  mode: VerifyMode,
  reports: readonly BrowserReport[],
  skippedBrowsers: readonly { browser: VerifyBrowser; reason: string }[],
): VerifySummary {
  const allPassed = reports.every((report) => evaluateStabilityThresholds(report.scenarios).passed)
  return {
    mode,
    generatedAt: new Date().toISOString(),
    passed: mode === "baseline" ? true : allPassed && skippedBrowsers.length === 0,
    browsers: reports,
    skippedBrowsers,
  }
}

function browserExecutableExists(browser: VerifyBrowser): { exists: boolean; path: string } {
  const path = browser === "chromium" ? chromium.executablePath() : webkit.executablePath()
  return { exists: existsSync(path), path }
}

function main() {
  const options = parseVerifyArgs(process.argv.slice(2))
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  mkdirSync(options.outDir, { recursive: true })

  const skippedBrowsers: Array<{ browser: VerifyBrowser; reason: string }> = []
  const runnableBrowsers: VerifyBrowser[] = []

  for (const browser of options.browsers) {
    const check = browserExecutableExists(browser)
    if (!check.exists) {
      const hint = `Playwright ${browser} binary missing at ${check.path}. Install with: pnpm --filter @alook/web exec playwright install ${browser}`
      if (browser === "webkit" && options.allowMissingWebkit) {
        skippedBrowsers.push({ browser, reason: hint })
        continue
      }
      throw new Error(hint)
    }
    runnableBrowsers.push(browser)
  }

  const reports: BrowserReport[] = []
  for (const browser of runnableBrowsers) {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        "--config",
        "playwright.message-area.config.ts",
        `--project=${browser}`,
      ],
      {
        cwd: webRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          ALOOK_VERIFY_MODE: options.mode,
          ALOOK_VERIFY_OUT_DIR: options.outDir,
          ...(options.reuseServer ? { ALOOK_VERIFY_REUSE_SERVER: "1" } : {}),
        },
      },
    )

    const reportPath = resolve(options.outDir, `${browser}-report.json`)
    if (!existsSync(reportPath)) {
      throw new Error(
        `Verification run for ${browser} exited with ${String(result.status)} without writing ${reportPath}`,
      )
    }
    const rawReport = JSON.parse(readFileSync(reportPath, "utf8")) as BrowserReport
    let mp4Path: string | null = null
    let videoConverter: BrowserReport["videoConverter"] = "webm-only"
    if (rawReport.webmPath && existsSync(rawReport.webmPath)) {
      const targetMp4 = resolve(options.outDir, `${browser}-message-area-${options.mode}.mp4`)
      const conversion = convertWebmToMp4(rawReport.webmPath, targetMp4, options.fps)
      mp4Path = conversion.mp4Path
      videoConverter = conversion.converter
    }
    const enriched: BrowserReport = { ...rawReport, mp4Path, videoConverter }
    writeFileSync(reportPath, JSON.stringify(enriched, null, 2))
    reports.push(enriched)

    if (options.mode === "assert" && result.status !== 0) {
      const summary = buildVerifySummary(options.mode, reports, skippedBrowsers)
      writeFileSync(resolve(options.outDir, "summary.json"), JSON.stringify(summary, null, 2))
      process.exit(result.status ?? 1)
    }
  }

  const summary = buildVerifySummary(options.mode, reports, skippedBrowsers)
  const summaryPath = resolve(options.outDir, "summary.json")
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ summaryPath, passed: summary.passed, browsers: reports.map((r) => ({ browser: r.browser, mp4Path: r.mp4Path, passed: r.passed, violations: r.violations })) }, null, 2))
  if (!summary.passed) process.exit(1)
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntrypoint) {
  main()
}
