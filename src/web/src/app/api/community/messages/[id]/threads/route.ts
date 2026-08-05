import { NextRequest } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { createThreadForUser } from "@/lib/community/create-channels"

/**
 * Message-keyed thread-create door (route/disc trunk — message-keyed faces
 * dual-actor). withCommunityActor: human (session) + bot (crk_, the folded
 * build-thread verb) hit one route. Authorization is credential-scoped —
 * requireChannelMember on the message's channel keyed on `ctx.actor.userId`, so
 * a bot creating a thread runs the SAME gate a human does. A thread only roots
 * on a top-level channel message (no DM/child), so no DM arm here.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  // Defensive bot→404 (①-C): there is NO bot thread-create verb in the ServerApi
  // contract (send/read/reactAdd/resolve/… carry no thread-create), so no bot
  // caller reaches this route today and the retarget wires none (double
  // unreachable — Aigneis #320). 5c opened bot credentials on the route;
  // collapse the bot arm to an opaque 404 rather than let a future thread-create
  // verb slip through to the bare `requireChannelMember` below (whose 403 for a
  // known-but-non-member channel would leak the message/channel exists to a
  // bot). Human path unchanged. If a bot thread-create verb is ever added, it
  // must route through resolveTargetForMember (member-scoped → 404) like
  // reactions/seq — this guard is the reminder, not the feature.
  if (ctx.actor.kind === "bot") return writeError("not found", 404)

  const messageId = ctx.params?.id
  if (!messageId) return writeError("missing message id", 400)

  const db = getDb(ctx.env.DB)

  let body: { name?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  // Single-source creation core (route/disc create-door step): shares the same
  // createThreadForUser the `POST /channels` door dispatches for the thread type.
  // ⚠ BEHAVIOR CHANGE (Melly #471, Ingaborg #472): the former inline 409
  // "already has a thread" pre-check is retired — thread is get-or-create by the
  // root-message anchor, so re-creating on a message that already has a thread
  // returns that thread (idempotent), unifying with the send-path
  // createThreadIfMissing. The 409 was never a consumed signal (no caller
  // branched on it). Top-level/bearing guards + participant seeding are in the
  // helper. Kept alive through deploy; deleted at the flat-delete step.
  const result = await createThreadForUser(db, { messageId, actorUserId: ctx.actor.userId, name: body.name })
  if (!result.ok) return writeError(result.error, result.status)

  return writeJSON(result.value, 201)
})
