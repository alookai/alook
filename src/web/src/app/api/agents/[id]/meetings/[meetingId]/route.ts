import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { withWorkspaceMember } from "@/lib/middleware/workspace"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { meetingToResponse } from "@/lib/api/responses"
import { getDb } from "@/lib/db"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx)
  if (ws instanceof Response) return ws

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const meetingId = ctx.params?.meetingId
  if (!meetingId) return writeError("meeting id is required", 400)

  const meeting = await queries.meetingSession.getMeetingSession(
    db,
    meetingId,
    ws.workspaceId
  )
  if (!meeting) return writeError("meeting not found", 404)

  return writeJSON(meetingToResponse(meeting))
})

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx)
  if (ws instanceof Response) return ws

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const meetingId = ctx.params?.meetingId
  if (!meetingId) return writeError("meeting id is required", 400)

  const deleted = await queries.meetingSession.deleteMeetingSession(
    db,
    meetingId,
    ws.workspaceId
  )
  if (!deleted) return writeError("meeting not found", 404)

  return writeJSON({ ok: true })
})
