import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { chromium, type Browser } from "playwright-core"
import { createServer, type Server } from "http"
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import {
  joinMeeting,
  enableCaptions,
  isMeetingActive,
  leaveMeeting,
  buildCaptionObserverScript,
  buildCaptionScrapeScript,
  parseCaptionElements,
  deduplicateCaptions,
  findChrome,
} from "../../src/browser/index"
import type { BrowserPage } from "../../src/browser/index"

const _dir = dirname(fileURLToPath(import.meta.url))
const mockHtml = readFileSync(join(_dir, "mock-meet.html"), "utf-8")

let server: Server
let serverUrl: string
let browser: Browser

beforeAll(async () => {
  const chromePath = findChrome()
  if (!chromePath) {
    console.warn("SKIP: Chrome not installed — browser integration tests require Chrome")
    return
  }

  server = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(mockHtml)
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const addr = server.address()
  const port = typeof addr === "object" && addr ? addr.port : 0
  serverUrl = `http://localhost:${port}`

  browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
  })
}, 30_000)

afterAll(async () => {
  await browser?.close().catch(() => {})
  server?.close()
}, 30_000)

function skipIfNoBrowser() {
  if (!browser) {
    console.warn("skipped — no Chrome")
    return true
  }
  return false
}

describe("meet-navigator (browser integration)", () => {
  it("joins meeting, types bot name, and mutes mic/camera", async () => {
    if (skipIfNoBrowser()) return
    const page = await browser.newPage()
    const bp = page as unknown as BrowserPage

    await joinMeeting(bp, serverUrl, "Test Bot")

    const nameVal = await page.inputValue("#name-input")
    expect(nameVal).toBe("Test Bot")

    const micMuted = await page.getAttribute("#mic-btn", "data-is-muted")
    expect(micMuted).toBe("true")

    const camMuted = await page.getAttribute("#cam-btn", "data-is-muted")
    expect(camMuted).toBe("true")

    const joinVisible = await page.isVisible("#join-btn")
    expect(joinVisible).toBe(false)

    const leaveVisible = await page.isVisible("#leave-btn")
    expect(leaveVisible).toBe(true)

    await page.close()
  }, 15_000)

  it("detects meeting is active after joining", async () => {
    if (skipIfNoBrowser()) return
    const page = await browser.newPage()
    const bp = page as unknown as BrowserPage

    await joinMeeting(bp, serverUrl, "Test Bot")

    const active = await isMeetingActive(bp)
    expect(active).toBe(true)

    await page.close()
  }, 15_000)

  it("enables captions and scrapes them", async () => {
    if (skipIfNoBrowser()) return
    const page = await browser.newPage()
    const bp = page as unknown as BrowserPage

    await joinMeeting(bp, serverUrl, "Test Bot")
    await page.evaluate(buildCaptionObserverScript())
    await enableCaptions(bp)

    await page.waitForTimeout(500)

    const script = buildCaptionScrapeScript()
    const rawElements = await page.evaluate(script) as { speakerHtml: string; textHtml: string }[]
    const captions = parseCaptionElements(rawElements)

    expect(captions.length).toBeGreaterThanOrEqual(2)
    expect(captions[0].speaker).toBe("Alice")
    expect(captions[0].text).toBe("Hello everyone")
    expect(captions[1].speaker).toBe("Bob")
    expect(captions[1].text).toContain("Hi Alice")

    await page.close()
  }, 15_000)

  it("deduplicates when last caption repeats (real Meet behavior)", async () => {
    if (skipIfNoBrowser()) return
    const page = await browser.newPage()
    const bp = page as unknown as BrowserPage

    await joinMeeting(bp, serverUrl, "Test Bot")
    await page.evaluate(buildCaptionObserverScript())
    await enableCaptions(bp)
    await page.waitForTimeout(500)

    const script = buildCaptionScrapeScript()
    const raw = await page.evaluate(script) as { speakerHtml: string; textHtml: string }[]
    const captions = parseCaptionElements(raw)
    const transcript = deduplicateCaptions([], captions, 0, 5000)

    expect(transcript.length).toBeGreaterThanOrEqual(2)

    const lastCaption = captions[captions.length - 1]
    const repeated = deduplicateCaptions(transcript, [lastCaption], 0, 8000)

    expect(repeated.length).toBe(transcript.length)

    await page.close()
  }, 15_000)

  it("leaves meeting and meeting becomes inactive", async () => {
    if (skipIfNoBrowser()) return
    const page = await browser.newPage()
    const bp = page as unknown as BrowserPage

    await joinMeeting(bp, serverUrl, "Test Bot")

    const activeBefore = await isMeetingActive(bp)
    expect(activeBefore).toBe(true)

    await leaveMeeting(bp)

    const activeAfter = await isMeetingActive(bp)
    expect(activeAfter).toBe(false)

    await page.close()
  }, 15_000)
})
