import { withAuth } from "@/lib/middleware/auth-policy"
import { communityChannelResourceFromStorage } from "@alook/shared"
import { NextRequest } from "next/server"
import { communityActorPolicy } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb, getPrimaryDb } from "@/lib/db"
import {
  createServerChannelForUser,
  createDmForUser,
  createThreadForUser,
} from "@/lib/community/create-channels"

/**
 * Bot creation is denied before target resolution to prevent existence leaks.
 * Top-level creation is a capability restriction. DM/thread creation also
 * stays denied: bot send owns their current get-or-create path, and this
 * endpoint has no supported bot target descriptor.
 */
export const POST = withAuth(communityActorPolicy(), async (req: NextRequest, ctx) => {
  let body: {
    type?: unknown
    serverId?: unknown
    name?: unknown
    categoryId?: unknown
    topic?: unknown
    userId?: unknown
    messageId?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  // Bot capability boundary — rejected BEFORE resolving/probing any target, so
  // every bot rejection is target-independent (zero existence leak). See the two
  // segments in the route doc: (1) channel-create is a permanent capability
  // reject; (2) dm/thread is a defensive reject (no bot verb today).
  if (ctx.actor.kind === "bot") {
    return writeError("forbidden: creating channels is not available to bots", 403)
  }
  const actorUserId = ctx.actor.userId
  // Opening a DM is read-before-write authorization. Keep other channel kinds
  // on their existing session policy, but force the DM guard onto primary so a
  // recent unfriend/block is immediately authoritative.
  const db = body.type === "dm" ? getPrimaryDb(ctx.env.DB) : getDb(ctx.env.DB)

  switch (body.type) {
    case "text":
    case "forum":
    case undefined: {
      // text/forum channel under a server (undefined type defaults to text, same
      // as the legacy route + createChannel default).
      if (typeof body.serverId !== "string" || !body.serverId) {
        return writeError("serverId is required", 400)
      }
      const result = await createServerChannelForUser(db, {
        serverId: body.serverId,
        actorUserId,
        name: body.name,
        type: body.type,
        categoryId: body.categoryId,
        topic: body.topic,
      })
      if (!result.ok) return writeError(result.error, result.status)
      return writeJSON({ channel: result.value }, 201)
    }
    case "dm": {
      const result = await createDmForUser(db, { actorUserId, peerUserId: body.userId })
      if (!result.ok) return writeError(result.error, result.status)
      return writeJSON({ conversation: result.value }, 201)
    }
    case "thread": {
      if (typeof body.messageId !== "string" || !body.messageId) {
        return writeError("messageId is required", 400)
      }
      const result = await createThreadForUser(db, {
        messageId: body.messageId,
        actorUserId,
        name: body.name,
      })
      if (!result.ok) return writeError(result.error, result.status)
      return writeJSON(communityChannelResourceFromStorage(result.value), 201)
    }
    default:
      return writeError("type must be one of 'text', 'forum', 'dm', 'thread'", 400)
  }
})
