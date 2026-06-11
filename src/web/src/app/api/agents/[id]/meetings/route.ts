import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, MeetingStatus } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { withWorkspaceMember } from "@/lib/middleware/workspace"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { meetingToResponse } from "@/lib/api/responses"
import { getDb } from "@/lib/db"
import { broadcastToDaemon } from "@/lib/broadcast"

const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx)
  if (ws instanceof Response) return ws

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const agentId = ctx.params?.id
  if (!agentId) return writeError("agent id is required", 400)

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId)
  if (!agent) return writeError("not found", 404)

  const meetings = await queries.meetingSession.listMeetingSessions(
    db,
    agentId,
    ws.workspaceId
  )

  return writeJSON(meetings.map(meetingToResponse))
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx)
  if (ws instanceof Response) return ws

  const { env } = getCloudflareContext()
  const cfEnv = env as Env
  const db = getDb(cfEnv.DB)

  const agentId = ctx.params?.id
  if (!agentId) return writeError("agent id is required", 400)

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId)
  if (!agent) return writeError("not found", 404)

  let body: {
    meetingUrl?: string
    title?: string
    participants?: string[]
    scheduledAt?: string
  }
  try {
    body = await req.json() as typeof body
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.meetingUrl) return writeError("meetingUrl is required", 400)
  if (!MEET_URL_RE.test(body.meetingUrl)) return writeError("invalid Google Meet URL format", 400)

  const meeting = await queries.meetingSession.createMeetingSession(db, {
    agentId,
    workspaceId: ws.workspaceId,
    title: body.title ?? "",
    meetingUrl: body.meetingUrl,
    status: MeetingStatus.SCHEDULED,
    isWhitelisted: true,
    participants: body.participants ?? [],
    scheduledAt: body.scheduledAt ?? new Date().toISOString(),
  })

  const created = await queries.meetingSession.getMeetingSession(db, meeting.id, ws.workspaceId)
  if (!created) return writeError("meeting not found", 404)

  if (agent.runtimeId) {
    const runtime = await queries.runtime.getAgentRuntime(db, agent.runtimeId)
    if (runtime) {
      const scheduledTime = body.scheduledAt ? new Date(body.scheduledAt) : new Date()
      const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000)
      if (scheduledTime <= fiveMinFromNow) {
        broadcastToDaemon(runtime.daemonId, {
          type: "daemon.meetings",
          meetings: [{
            id: created.id,
            meeting_url: created.meetingUrl,
            participants: created.participants as string[],
            workspace_id: ws.workspaceId,
            agent_id: agentId,
            agent_name: agent.name ?? "",
            title: created.title || undefined,
          }],
        }).catch(() => {})
      }
    }
  }

  return writeJSON(meetingToResponse(created), 201)
})
