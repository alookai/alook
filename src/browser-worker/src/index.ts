import { nanoid } from "nanoid"
import type { MeetingBotEnv } from "./types"
import { isValidMeetUrl } from "./lib/meet-navigator"

export { MeetingBotDO } from "./meeting-bot-do"

export default {
  async fetch(request: Request, env: MeetingBotEnv): Promise<Response> {
    const url = new URL(request.url)

    const joinMatch = url.pathname === "/meeting/join"
    if (joinMatch && request.method === "POST") {
      return this.handleJoin(request, env)
    }

    const statusMatch = url.pathname.match(/^\/meeting\/([^/]+)\/status$/)
    if (statusMatch && request.method === "GET") {
      return this.handleGetStatus(statusMatch[1], env)
    }

    const stopMatch = url.pathname.match(/^\/meeting\/([^/]+)\/stop$/)
    if (stopMatch && request.method === "POST") {
      return this.handleStop(stopMatch[1], env)
    }

    if (request.method !== "POST" && request.method !== "GET") {
      return Response.json({ error: "method not allowed" }, { status: 405 })
    }

    return Response.json({ error: "not found" }, { status: 404 })
  },

  async handleJoin(request: Request, env: MeetingBotEnv): Promise<Response> {
    const body = await request.json() as {
      meetingUrl?: string
      participants?: string[]
      meetingId?: string
      workspaceId?: string
    }

    if (!body.meetingUrl) {
      return Response.json({ error: "meetingUrl is required" }, { status: 400 })
    }

    if (!isValidMeetUrl(body.meetingUrl)) {
      return Response.json({ error: "invalid Google Meet URL format" }, { status: 400 })
    }

    const sessionId = nanoid()
    const doId = env.MEETING_BOT.idFromName(sessionId)
    const stub = env.MEETING_BOT.get(doId)

    const doResponse = await stub.fetch(new Request("http://internal/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        meetingUrl: body.meetingUrl,
        participants: body.participants ?? [],
        meetingId: body.meetingId,
        workspaceId: body.workspaceId,
      }),
    }))

    const result = await doResponse.json() as Record<string, unknown>

    if (!doResponse.ok) {
      return Response.json(result, { status: doResponse.status })
    }

    return Response.json({
      ...result,
      sessionId,
    })
  },

  async handleGetStatus(sessionId: string, env: MeetingBotEnv): Promise<Response> {
    if (!sessionId) {
      return Response.json({ error: "session id is required" }, { status: 400 })
    }

    const doId = env.MEETING_BOT.idFromName(sessionId)
    const stub = env.MEETING_BOT.get(doId)

    const doResponse = await stub.fetch(new Request("http://internal/status", {
      method: "GET",
    }))

    const result = await doResponse.json()
    return Response.json(result)
  },

  async handleStop(sessionId: string, env: MeetingBotEnv): Promise<Response> {
    if (!sessionId) {
      return Response.json({ error: "session id is required" }, { status: 400 })
    }

    const doId = env.MEETING_BOT.idFromName(sessionId)
    const stub = env.MEETING_BOT.get(doId)

    const doResponse = await stub.fetch(new Request("http://internal/stop", {
      method: "POST",
    }))

    const result = await doResponse.json()
    return Response.json(result)
  },
}
