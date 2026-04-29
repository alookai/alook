import { chromium } from "playwright-core"
import {
  ensureChrome,
  joinMeeting,
  enableCaptions,
  waitForMeetingReady,
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
const BOT_NAME = "Alook Meeting Bot"

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

  log("Launching browser (en-US, stealth)...")
  const browser = await chromium.launch({
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
    log("Joining meeting...")
    try {
      await joinMeeting(page, input.meetingUrl, BOT_NAME)
      log("Joined. Waiting for meeting UI...")
      await waitForMeetingReady(page)
      // Mute mic/camera after entering meeting
      await page.evaluate(() => {
        for (const btn of document.querySelectorAll('button')) {
          const label = (btn.getAttribute('aria-label') || '').toLowerCase()
          if (label.startsWith('turn off') && (label.includes('microphone') || label.includes('camera'))) {
            (btn as HTMLElement).click()
          }
        }
      })
      log("Meeting ready. Enabling captions...")
    } catch (joinErr) {
      const screenshotPath = `/tmp/meeting-${input.meetingId}-fail.png`
      await page.screenshot({ path: screenshotPath }).catch(() => {})
      log(`Join failed, screenshot: ${screenshotPath}`)
      throw joinErr
    }
    await enableCaptions(page)
    await page.evaluate(buildCaptionObserverScript())
    await page.screenshot({ path: `/tmp/meeting-${input.meetingId}-after-cc.png` }).catch(() => {})
    log("Captions enabled, observer injected. Scraping loop started.")

    let scrapeCount = 0
    while (true) {
      try {
        const active = await isMeetingActive(page)
        if (!active) {
          log("Meeting ended (no longer active)")
          break
        }

        const script = buildCaptionScrapeScript()
        const rawElements = await page.evaluate(script) as { speakerHtml: string; textHtml: string }[]
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
    const transcriptText = formatTranscript(transcript)
    log(`Completed: ${transcript.length} transcript entries`)
    await callbackWeb(input, "completed", transcriptText)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Error: ${msg}`)
    await callbackWeb(input, "failed", undefined, msg)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
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
