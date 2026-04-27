import type { BrowserWorker } from "@cloudflare/puppeteer"

export interface MeetingBotEnv {
  BROWSER: BrowserWorker
  MEETING_BOT: DurableObjectNamespace
  EMAIL_SERVICE: Fetcher
  WEB_SERVICE: Fetcher
}

export type MeetingStatus = "starting" | "joining" | "recording" | "stopping" | "completed" | "failed"

export interface MeetingSession {
  id: string
  meetingUrl: string
  status: MeetingStatus
  participants: string[]
  startedAt: string
  error?: string
}
