import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, withD1Retry } from "@alook/shared"
import { guardDmOpen } from "@/lib/community/dm-guard"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  // `withD1Retry` (D1-armor: no-fallback DM-list read; retry to truth).
  const rows = await withD1Retry(() => queries.communityDm.listDMs(db, ctx.userId), {
    route: "dm/list",
  })
  const conversations = rows.map((r) => ({
    id: r.id,
    userId: r.otherUserId,
    name: r.otherUserName,
    discriminator: r.otherUserDiscriminator,
    avatar: r.otherUserImage ?? avatarInitial(r.otherUserName),
    status: "offline" as const,
    preview: "",
  }))
  return writeJSON({ conversations })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { userId: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.userId) return writeError("userId is required", 400)

  // Default callerKind ("human") — 404-on-friend-failure / pass-as-human
  // preserved exactly as this route's pre-extraction behavior.
  const guard = await guardDmOpen(db, ctx.userId, body.userId)
  if (!guard.ok) return writeError(guard.error, guard.status)

  // `withD1Retry` (D1-armor, team-ruled): createOrGetDM is get-first-then-create,
  // so a response-lost RETRY is safe (the retry finds the existing channel). A
  // true-concurrency double-create is a pre-existing race orthogonal to retry
  // (tracked as a separate backlog ticket: pair-key unique constraint); wrapping
  // in withD1Retry adds no new risk and armors the transient path.
  const dm = await withD1Retry(
    () =>
      queries.communityDm.createOrGetDM(db, {
        userId1: ctx.userId,
        userId2: body.userId,
      }),
    { route: "dm/create-or-get" },
  )

  return writeJSON({ conversation: dm })
})
