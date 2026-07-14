import type { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { parseAuditLogPayload } from "@/lib/community/audit-log-payload"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

/**
 * GET /api/community/bots/[id]/audit-log
 *
 * Owner-only. Returns a page of bot activity events, newest first, with
 * composite `(before_created_at, before_id)` cursor pagination — a single
 * timestamp cursor would drop events tied at the same millisecond, so both
 * halves are required and applied together in the query.
 *
 * 404 on: unknown bot, bot not owned by the session user, or bot soft-deleted
 * (per plan §API — the ownership + deletedAt filter is scoped up-front, never
 * fetch-then-check).
 */
export const GET = withAuth(async (req: NextRequest, ctx) => {
  const id = ctx.params?.id as string
  const db = getDb(ctx.env.DB)

  // Ownership + soft-delete gate — matches `getBotOwnedBy` predicate.
  const bot = await queries.communityBot.getBotOwnedBy(db, id, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  const url = new URL(req.url)
  const beforeCreatedAt = url.searchParams.get("beforeCreatedAt") ?? undefined
  const beforeId = url.searchParams.get("beforeId") ?? undefined
  const limitRaw = url.searchParams.get("limit")
  const limit = limitRaw
    ? Math.max(1, Math.min(MAX_LIMIT, Number.parseInt(limitRaw, 10) || DEFAULT_LIMIT))
    : DEFAULT_LIMIT

  const rows = await queries.communityBotAuditLog.listBotActivityEvents(db, {
    botId: id,
    beforeCreatedAt,
    beforeId,
    limit,
  })

  const events = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    payload: parseAuditLogPayload(r.kind, r.payload),
    sessionId: r.sessionId,
    launchId: r.launchId,
    createdAt: r.createdAt,
  }))

  const last = rows[rows.length - 1]
  const nextCursor =
    rows.length >= limit && last
      ? { beforeCreatedAt: last.createdAt, beforeId: last.id }
      : null

  return writeJSON({ events, nextCursor })
})
