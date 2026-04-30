import { chromium } from "playwright-core"
import {
  ensureChrome,
  joinMeeting,
  enableCaptions,
  waitForMeetingReady,
  buildAloneDetectorScript,
  isMeetingActive,
  leaveMeeting,
  buildCaptionObserverScript,
  buildCaptionScrapeScript,
  parseCaptionElements,
  deduplicateCaptions,
  formatTranscript,
} from "@alook/shared/browser"
import type { TranscriptEntry } from "@alook/shared/browser"

const SCRAPE_INTERVAL_MS = 3_000
const DEFAULT_BOT_NAME = "Alook Meeting Bot"
const MAX_RETRY_DURATION_MS = 30 * 60 * 1000
const RETRY_BACKOFF = [30_000, 60_000, 120_000, 300_000]

function log(msg: string) {
  console.log(`[meeting-runner] ${new Date().toISOString()} ${msg}`)
}

export interface MeetingRunnerInput {
  meetingId: string
  meetingUrl: string
  participants: string[]
  workspaceId: string
  callbackUrl: string
  authToken: string
  agentName?: string
}

async function callbackWeb(
  input: MeetingRunnerInput,
  status: "completed" | "failed",
  transcript?: string,
  error?: string,
): Promise<void> {
  const payload = JSON.stringify({
    meetingId: input.meetingId,
    workspaceId: input.workspaceId,
    status,
    transcript: transcript || undefined,
    error: error || undefined,
  })

  try {
    const res = await fetch(`${input.callbackUrl}/api/meeting/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.authToken}`,
      },
      body: payload,
    })
    log(`Callback ${status} → ${res.status}`)
  } catch (err) {
    log(`Callback failed: ${err instanceof Error ? err.message : err}`)
  }
}

function launchBrowser(chromePath: string) {
  return chromium.launch({
    executablePath: chromePath,
    headless: false,
    args: [
      "--lang=en-US",
      "--disable-blink-features=AutomationControlled",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--disable-audio-output",
    ],
  })
}

async function tryJoinAndRecord(input: MeetingRunnerInput, chromePath: string): Promise<{ status: "completed" | "blocked" | "error"; transcript: TranscriptEntry[]; error?: string }> {
  const browser = await launchBrowser(chromePath)
  const context = browser.contexts()[0]
  if (context) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false })
    })
  }

  const page = await browser.newPage({ locale: "en-US" })
  const meetingStartMs = Date.now()
  let transcript: TranscriptEntry[] = []

  try {
    const botName = input.agentName ? `${input.agentName} (Alook)` : DEFAULT_BOT_NAME
    await joinMeeting(page, input.meetingUrl, botName)
    log("Joined. Waiting for meeting UI...")
    await waitForMeetingReady(page)

    await page.evaluate(() => {
      for (const btn of document.querySelectorAll('button')) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase()
        if (label.startsWith('turn off') && (label.includes('microphone') || label.includes('camera'))) {
          (btn as HTMLElement).click()
        }
      }
    })
    log("Meeting ready. Enabling captions...")

    await enableCaptions(page)
    await page.evaluate(buildCaptionObserverScript())
    await page.evaluate(buildAloneDetectorScript())
    log("Captions enabled, observer injected. Scraping loop started.")

    let scrapeCount = 0
    while (true) {
      try {
        const active = await isMeetingActive(page)
        if (!active) {
          const finalRaw = await page.evaluate(buildCaptionScrapeScript()) as { speakerHtml: string; textHtml: string }[]
          const finalCaptions = parseCaptionElements(finalRaw)
          if (finalCaptions.length > 0) {
            transcript = deduplicateCaptions(transcript, finalCaptions, meetingStartMs, Date.now())
            log(`Final scrape: ${finalCaptions.length} caption(s), total ${transcript.length}`)
          }
          log("Meeting ended (no longer active)")
          break
        }

        const rawElements = await page.evaluate(buildCaptionScrapeScript()) as { speakerHtml: string; textHtml: string }[]
        const captions = parseCaptionElements(rawElements)
        scrapeCount++

        if (captions.length > 0) {
          const prevLen = transcript.length
          transcript = deduplicateCaptions(transcript, captions, meetingStartMs, Date.now())
          if (transcript.length > prevLen) {
            log(`Caption: ${captions[captions.length - 1].speaker}: "${captions[captions.length - 1].text}" (total ${transcript.length})`)
          }
        } else if (scrapeCount <= 5) {
          log(`Scrape #${scrapeCount}: no captions yet`)
        }
      } catch (err) {
        log(`Scrape error: ${err instanceof Error ? err.message : err}`)
        break
      }

      await new Promise((resolve) => setTimeout(resolve, SCRAPE_INTERVAL_MS))
    }

    await leaveMeeting(page)
    return { status: "completed", transcript }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("Blocked from joining")) {
      const screenshotPath = `/tmp/meeting-${input.meetingId}-blocked.png`
      await page.screenshot({ path: screenshotPath }).catch(() => {})
      log(`Blocked — screenshot: ${screenshotPath}`)
      return { status: "blocked", transcript, error: msg }
    }
    log(`Error: ${msg}`)
    return { status: "error", transcript, error: msg }
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

async function run(input: MeetingRunnerInput): Promise<void> {
  log(`Starting: ${input.meetingUrl} (${input.meetingId})`)

  let chromePath: string
  try {
    chromePath = ensureChrome()
    log(`Chrome found: ${chromePath}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Chrome setup failed: ${msg}`)
    await callbackWeb(input, "failed", undefined, `Chrome setup failed: ${msg}`)
    process.exit(1)
  }

  const startTime = Date.now()
  let attempt = 0

  while (true) {
    attempt++
    log(attempt > 1 ? `Retry attempt #${attempt}...` : "Launching browser (en-US, stealth)...")

    const result = await tryJoinAndRecord(input, chromePath)

    if (result.status === "completed") {
      const transcriptText = formatTranscript(result.transcript)
      log(`Completed: ${result.transcript.length} transcript entries`)
      await callbackWeb(input, "completed", transcriptText)
      return
    }

    if (result.status === "blocked") {
      const elapsed = Date.now() - startTime
      if (elapsed >= MAX_RETRY_DURATION_MS) {
        log(`Giving up after ${Math.round(elapsed / 60_000)}min of retries`)
        await callbackWeb(input, "failed", undefined, result.error)
        return
      }
      const backoff = RETRY_BACKOFF[Math.min(attempt - 1, RETRY_BACKOFF.length - 1)]
      log(`Blocked, retrying in ${backoff / 1000}s (attempt ${attempt}, ${Math.round(elapsed / 60_000)}min elapsed)`)
      await new Promise((resolve) => setTimeout(resolve, backoff))
      continue
    }

    // Other errors — don't retry
    await callbackWeb(input, "failed", undefined, result.error)
    return
  }
}

const encoded = process.argv[2]
if (!encoded) {
  console.error("Usage: meeting-runner <base64-encoded-input>")
  process.exit(1)
}

const input: MeetingRunnerInput = JSON.parse(
  Buffer.from(encoded, "base64").toString("utf-8"),
)

run(input).then(() => process.exit(0)).catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
