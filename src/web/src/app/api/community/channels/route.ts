import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  createServerChannelForUser,
  createDmForUser,
  createThreadForUser,
} from "@/lib/community/create-channels"

/**
 * POST /api/community/channels — the create door (route/disc trunk 接口树统一,
 * create-door step). ONE collection-level route that creates any channel kind,
 * dispatching on the requested `type`'s creation trait:
 *   - text / forum → reject-on-collision (by server-scoped name)
 *   - dm           → get-or-create by peer identity (createOrGetDM)
 *   - thread       → get-or-create by root-message anchor
 * It folds the three legacy create entries (servers/[id]/channels POST, dm POST,
 * messages/[id]/threads POST), which now call the SAME single-source cores in
 * create-channels.ts and stay alive transitionally (deleted at the flat-delete
 * step after the deploy window closes).
 *
 * This is the HUMAN arm (`withAuth`). The bot arm is a separate carve-out commit:
 * the door dispatches 4 types, but bot CAPABILITY is minimal and orthogonal to
 * dispatch — bot may create thread/DM only (already implicit via send today,
 * ①-C existence-mask), while text/forum channel-create stays human-only (bot →
 * 403 capability-reject, reject-before-resolve). Not wired here.
 *
 * Descriptor is discriminated on `type`; the parent is addressed by the id each
 * kind needs (serverId / peer userId / root messageId).
 */
export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

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
        actorUserId: ctx.userId,
        name: body.name,
        type: body.type,
        categoryId: body.categoryId,
        topic: body.topic,
      })
      if (!result.ok) return writeError(result.error, result.status)
      return writeJSON({ channel: result.value }, 201)
    }
    case "dm": {
      const result = await createDmForUser(db, { actorUserId: ctx.userId, peerUserId: body.userId })
      if (!result.ok) return writeError(result.error, result.status)
      return writeJSON({ conversation: result.value }, 201)
    }
    case "thread": {
      if (typeof body.messageId !== "string" || !body.messageId) {
        return writeError("messageId is required", 400)
      }
      const result = await createThreadForUser(db, {
        messageId: body.messageId,
        actorUserId: ctx.userId,
        name: body.name,
      })
      if (!result.ok) return writeError(result.error, result.status)
      return writeJSON(result.value, 201)
    }
    default:
      return writeError("type must be one of 'text', 'forum', 'dm', 'thread'", 400)
  }
})
