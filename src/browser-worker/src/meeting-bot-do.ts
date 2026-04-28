import { DurableObject } from "cloudflare:workers"
import { chromium, endpointURLString } from "@cloudflare/playwright"
import type { Browser, Page } from "@cloudflare/playwright"
import type { MeetingBotEnv, MeetingStatus } from "./types"
import type { TranscriptEntry } from "@alook/shared/browser"
import {
  deduplicateCaptions,
  formatTranscript,
  buildCaptionScrapeScript,
  parseCaptionElements,
  joinMeeting,
  enableCaptions,
  leaveMeeting,
  isMeetingActive,
} from "@alook/shared/browser"
import { DEV_WEB_URL } from "@alook/shared"

const SCRAPE_INTERVAL_MS = 3_000
const BOT_NAME = "Alook Meeting Bot"

export class MeetingBotDO extends DurableObject<MeetingBotEnv> {
  private browser: Browser | null = null
  private page: Page | null = null
  private status: MeetingStatus = "starting"
  private meetingUrl = ""
  private participants: string[] = []
  private transcript: TranscriptEntry[] = []
  private meetingStartMs = 0
  private error: string | null = null
  private meetingId: string | null = null
  private workspaceId: string | null = null

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/start" && request.method === "POST") {
      return this.handleStart(request)
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return this.handleStatus()
    }

    if (url.pathname === "/stop" && request.method === "POST") {
      return this.handleStop()
    }

    return Response.json({ error: "not found" }, { status: 404 })
  }

  private async handleStart(request: Request): Promise<Response> {
    const body = await request.json() as {
      meetingUrl?: string
      participants?: string[]
      meetingId?: string
      workspaceId?: string
    }

    if (!body.meetingUrl) {
      return Response.json({ error: "meetingUrl is required" }, { status: 400 })
    }

    this.meetingUrl = body.meetingUrl
    this.participants = body.participants ?? []
    this.meetingId = body.meetingId ?? null
    this.workspaceId = body.workspaceId ?? null
    this.status = "starting"
    this.transcript = []
    this.meetingStartMs = Date.now()

    try {
      this.status = "joining"
      const endpoint = endpointURLString(this.env.BROWSER, { keep_alive: 600_000 })
      this.browser = await chromium.connect(endpoint)
      this.page = await this.browser.newPage()

      await joinMeeting(this.page, this.meetingUrl, BOT_NAME)
      await enableCaptions(this.page)

      this.status = "recording"

      this.ctx.waitUntil(this.scrapeLoop())

      return Response.json({
        ok: true,
        status: this.status,
        startedAt: new Date(this.meetingStartMs).toISOString(),
      })
    } catch (err) {
      this.status = "failed"
      this.error = err instanceof Error ? err.message : String(err)
      await this.cleanup()
      await this.callbackWeb("failed", "", this.error)
      return Response.json({ error: this.error, status: this.status }, { status: 500 })
    }
  }

  private handleStatus(): Response {
    return Response.json({
      status: this.status,
      meetingUrl: this.meetingUrl,
      participants: this.participants,
      transcriptLength: this.transcript.length,
      error: this.error,
    })
  }

  private async handleStop(): Promise<Response> {
    this.status = "stopping"

    if (this.page) {
      await leaveMeeting(this.page)
    }
    await this.cleanup()

    const transcriptText = formatTranscript(this.transcript)
    this.status = "completed"

    return Response.json({
      ok: true,
      status: this.status,
      transcript: transcriptText,
      entryCount: this.transcript.length,
    })
  }

  private async scrapeLoop(): Promise<void> {
    while (this.status === "recording" && this.page) {
      try {
        const active = await isMeetingActive(this.page)
        if (!active) {
          this.status = "stopping"
          break
        }

        const script = buildCaptionScrapeScript()
        const rawElements = await this.page.evaluate(script) as { speakerHtml: string; textHtml: string }[]
        const captions = parseCaptionElements(rawElements)

        if (captions.length > 0) {
          this.transcript = deduplicateCaptions(
            this.transcript,
            captions,
            this.meetingStartMs,
            Date.now(),
          )
        }
      } catch {
        if (this.status === "recording") continue
        break
      }

      await new Promise((resolve) => setTimeout(resolve, SCRAPE_INTERVAL_MS))
    }

    if (this.status === "stopping") {
      const transcriptText = formatTranscript(this.transcript)
      await this.cleanup()
      this.status = "completed"

      await this.callbackWeb("completed", transcriptText)
    }
  }

  private async callbackWeb(status: "completed" | "failed", transcript?: string, error?: string): Promise<void> {
    if (!this.meetingId || !this.workspaceId) return

    const payload = JSON.stringify({
      meetingId: this.meetingId,
      workspaceId: this.workspaceId,
      status,
      transcript: transcript || undefined,
      error: error || undefined,
    })

    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    }

    try {
      await this.env.WEB_SERVICE.fetch("http://internal/api/meeting/callback", init)
    } catch {
      try {
        await fetch(`${DEV_WEB_URL}/api/meeting/callback`, init)
      } catch {
        // Best-effort callback
      }
    }
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.page) {
        await this.page.close().catch(() => {})
        this.page = null
      }
      if (this.browser) {
        await this.browser.close().catch(() => {})
        this.browser = null
      }
    } catch {
      this.page = null
      this.browser = null
    }
  }
}
