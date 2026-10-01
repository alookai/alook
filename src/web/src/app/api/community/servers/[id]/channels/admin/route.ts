import { NextResponse } from "next/server"
import { queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withCommunityActor, rejectBot } from "@/lib/middleware/community-actor"
import { writeError } from "@/lib/middleware/helpers"
import { requireServerAdmin } from "@/lib/community/permissions"

const headers = { "Cache-Control": "private, no-store" }

export const GET = withCommunityActor(async (_req, ctx) => {
  const rejected = rejectBot(ctx.actor)
  if (rejected) {
    rejected.headers.set("Cache-Control", headers["Cache-Control"])
    return rejected
  }
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400, headers)

  const db = getPrimaryDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.actor.userId)
  if (!auth.ok) return writeError(auth.error, auth.status, headers)

  const channels = await queries.communityChannel.listServerChannelDirectoryForAdmin(db, serverId, ctx.actor.userId)
  return NextResponse.json({ channels }, { headers })
})
