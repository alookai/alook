import { chromium } from "playwright-core"
import {
  ensureChrome,
  joinMeeting,
  enableCaptions,
  isMeetingActive,
  leaveMeeting,
  buildCaptionScrapeScript,
  parseCaptionElements,
  deduplicateCaptions,
  formatTranscript,
} from "@alook/shared/browser"
import type { TranscriptEntry } from "@alook/shared/browser"

const SCRAPE_INTERVAL_MS = 3_000
const BOT_NAME = "Alook Meeting Bot"

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
    await fetch(`${input.callbackUrl}/api/meeting/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.authToken}`,
      },
      body: payload,
    })
  } catch {
    // Best-effort callback
  }
}

async function run(input: MeetingRunnerInput): Promise<void> {
  let chromePath: string
  try {
    chromePath = ensureChrome()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await callbackWeb(input, "failed", undefined, `Chrome setup failed: ${msg}`)
    process.exit(1)
  }

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--disable-audio-output",
    ],
  })

  const page = await browser.newPage()
  const meetingStartMs = Date.now()
  let transcript: TranscriptEntry[] = []

  try {
    await joinMeeting(page, input.meetingUrl, BOT_NAME)
    await enableCaptions(page)

    while (true) {
      try {
        const active = await isMeetingActive(page)
        if (!active) break

        const script = buildCaptionScrapeScript()
        const rawElements = await page.evaluate(script) as { speakerHtml: string; textHtml: string }[]
        const captions = parseCaptionElements(rawElements)

        if (captions.length > 0) {
          transcript = deduplicateCaptions(transcript, captions, meetingStartMs, Date.now())
        }
      } catch {
        break
      }

      await new Promise((resolve) => setTimeout(resolve, SCRAPE_INTERVAL_MS))
    }

    await leaveMeeting(page)
    const transcriptText = formatTranscript(transcript)
    await callbackWeb(input, "completed", transcriptText)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await callbackWeb(input, "failed", undefined, msg)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

// Entry point — receives base64-encoded MeetingRunnerInput as argv[2]
const encoded = process.argv[2]
if (!encoded) {
  console.error("Usage: meeting-runner <base64-encoded-input>")
  process.exit(1)
}

const input: MeetingRunnerInput = JSON.parse(
  Buffer.from(encoded, "base64").toString("utf-8"),
)

run(input).then(() => process.exit(0)).catch(() => process.exit(1))
