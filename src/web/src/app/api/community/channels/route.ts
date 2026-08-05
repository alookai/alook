import { NextRequest } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
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
 * Dual-actor (`withCommunityActor`), but bot CAPABILITY is minimal and ORTHOGONAL
 * to the 4-type dispatch — supporting a type ≠ opening it to bots. The bot arm is
 * two DIFFERENT rejections, kept distinct on purpose (Melly #486 / Aigneis #475):
 *
 *   (1) text/forum channel-create → 403 capability-reject, PERMANENT. This is a
 *       fixed capability boundary, NOT a deferred half: a bot creating a
 *       top-level channel changes server structure, a sensitive capability bots
 *       have never had. Granting it is an explicit capability EXPANSION (its own
 *       review), and it will NEVER open as a side effect of any future verb. The
 *       reject fires BEFORE resolving/touching any target → the 403 is
 *       channel-independent (zero existence leak, capability axis not existence
 *       axis, same form as members-POST #347).
 *
 *   (2) dm / thread → defensive reject, DEFERRED half. There is no bot
 *       create-DM/thread verb today (bots get DM/thread only as a get-or-create
 *       side effect of `send`, via resolve-ref — not this door), and no bot-ref
 *       descriptor shape is defined. So the bot arm here is defensive (reject
 *       BEFORE any target probe, never a bare requireChannelMember fallback whose
 *       known-non-member 403 would leak existence). When a real bot
 *       create-DM/thread verb lands, THAT commit builds the ①-C ref arm here —
 *       switch to resolveTargetForMember (ref → member-scoped → 404-before-mask,
 *       resolve≠create) with the descriptor's ref shape defined alongside the
 *       verb — and MUST verify it then (Ingaborg #485 tripwire: openable anytime,
 *       opening MUST test; never inherit "defensive passed" as verified).
 *
 * Human path is unchanged from the human-arm commit. Descriptor is discriminated
 * on `type`; the parent is addressed by the id each kind needs (serverId / peer
 * userId / root messageId).
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
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

  // Bot capability boundary — rejected BEFORE resolving/probing any target, so
  // every bot rejection is target-independent (zero existence leak). See the two
  // segments in the route doc: (1) channel-create is a permanent capability
  // reject; (2) dm/thread is a defensive reject (no bot verb today).
  if (ctx.actor.kind === "bot") {
    return writeError("forbidden: creating channels is not available to bots", 403)
  }
  const actorUserId = ctx.actor.userId

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
      return writeJSON(result.value, 201)
    }
    default:
      return writeError("type must be one of 'text', 'forum', 'dm', 'thread'", 400)
  }
})
