import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, MeetingStatus } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { withWorkspaceMember } from "@/lib/middleware/workspace"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { meetingToResponse } from "@/lib/api/responses"
import { getDb } from "@/lib/db"

const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx)
  if (ws instanceof Response) return ws

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const agentId = ctx.params?.id
  if (!agentId) return writeError("agent id is required", 400)

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

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId)
  if (!agent) return writeError("agent not found", 404)

  let body: {
    meetingUrl?: string
    title?: string
    participants?: string[]
    scheduledAt?: string
    immediate?: boolean
  }
  try {
    body = await req.json() as typeof body
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.meetingUrl) return writeError("meetingUrl is required", 400)
  if (!MEET_URL_RE.test(body.meetingUrl)) return writeError("invalid Google Meet URL format", 400)

  const shouldJoinNow = body.immediate === true || !body.scheduledAt

  const meeting = await queries.meetingSession.createMeetingSession(db, {
    agentId,
    workspaceId: ws.workspaceId,
    title: body.title ?? "",
    meetingUrl: body.meetingUrl,
    status: MeetingStatus.SCHEDULED,
    isWhitelisted: true,
    participants: body.participants ?? [],
    scheduledAt: shouldJoinNow ? new Date().toISOString() : body.scheduledAt!,
  })

  const created = await queries.meetingSession.getMeetingSession(db, meeting.id, ws.workspaceId)
  if (!created) return writeError("meeting not found", 404)
  return writeJSON(meetingToResponse(created), 201)
})
