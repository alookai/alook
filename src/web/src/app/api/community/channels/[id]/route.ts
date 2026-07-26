import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, UpdateChannelRequestSchema } from "@alook/shared"
import { requireChannelAccess, requireChannelMember } from "@/lib/community/permissions"
import { updateChannelUnified, deleteChannelUnified } from "@/lib/community/channel-service"

/**
 * GET /api/community/channels/[id] — read a single channel of any type.
 *
 * Two-step check preserves the 404-vs-403 contract sibling channel routes
 * honor: unknown channel → 404, known channel + non-member → 403.
 * `requireChannelMember` alone collapses both into 403 because the JOIN can't
 * tell the difference. Returns the bare channel object (matching the
 * still-live threads/[id] read, so a future fold-in needs no shape change).
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)
  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  return writeJSON(auth.value)
})

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }
  const parsed = UpdateChannelRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return writeError(first?.message ?? "invalid request body", 400)
  }

  const result = await updateChannelUnified(db, { userId: ctx.userId, access: access.value }, channelId, parsed.data)
  if (!result.ok) return writeError(result.error, result.status)
  return writeJSON(result.row)
})

export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)

  const result = await deleteChannelUnified(db, { userId: ctx.userId, access: access.value }, channelId)
  if (!result.ok) return writeError(result.error, result.status)

  return new Response(null, { status: 204 })
})
