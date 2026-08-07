import { NextRequest } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"
import { resolveTargetForMember } from "@/lib/community/resolve-ref"

// A bot addresses by ref-in-query (`?ref=`); the path `[id]` is then the
// `resolve` placeholder (a ref carries `/` and can't sit in a path segment).
// A human/web caller puts the real channelId in the path. Same one-door input
// as the messages door — id (path) xor ref (query).
const REF_PLACEHOLDER_ID = "resolve"

/**
 * GET /api/community/channels/:id/messages/seq/:seq
 *
 * Resolve a seq number to its message ID within a channel. Used for message
 * ref jumping: when the user clicks #123 and that message isn't loaded, we
 * need its ID to trigger an anchor fetch. Also the folded `resolve` bot verb's
 * seq→id lookup.
 *
 * Dual-actor door (route/disc trunk — message-keyed faces). withCommunityActor
 * serves human (session, id-in-path) + bot (crk_, ref-in-query). Two steps,
 * both arms:
 *   1. arrive at a channelId — human: path id; bot: `resolveTargetForMember`
 *      (member-scoped inner-join, so an unreachable channel yields ZERO rows →
 *      404 BEFORE the mask). This is why a bot never sees the mask's 403 for a
 *      known-but-non-member channel — it 404s here first (①-C uniform
 *      existence-mask; the 403 leak 5c newly exposed by opening this route to
 *      bot credentials, Blondie/Aigneis #294/#295). The human arm skips this
 *      step (it already holds an id), keeping its 403/404 split untouched.
 *   2. `requireMessageSurfaceAccess` — the SINGLE mask both arms share (§3, no
 *      standalone requireChannelMember): DM→requireDMAccess (incl block), else
 *      requireChannelMember; unknown id → opaque 404. Byte-identical to the
 *      pre-5c human path.
 * The seq lookup is channel-scoped (getMessageByChannelAndSeq), so a seq in a
 * channel the caller can't reach never returns another channel's message.
 *
 * Returns: { id: string } | { error: "not_found" }
 */
export const GET = withCommunityActor(async (req: NextRequest, ctx) => {
  const seqStr = ctx.params?.seq
  if (typeof seqStr !== "string") {
    return writeJSON({ error: "invalid_params" }, 400)
  }

  const seq = parseInt(seqStr, 10)
  if (isNaN(seq) || seq <= 0) {
    return writeJSON({ error: "invalid_seq" }, 400)
  }

  const db = getDb(ctx.env.DB)
  const userId = ctx.actor.userId

  // Step 1 — channelId. Bot: ref-in-query, member-scoped resolve (unreachable →
  // 404, never a leaking 403). Human: id-in-path, unchanged. NO create-if-
  // missing — a seq lookup is pure addressing (resolve≠create).
  let channelId: string
  const refParam = req.nextUrl.searchParams.get("ref")
  if (ctx.actor.kind === "bot" && refParam) {
    const resolved = await resolveTargetForMember(db, userId, refParam, {
      createDmIfMissing: false,
      createThreadIfMissing: false,
      callerKind: "bot",
    })
    if ("error" in resolved) return writeError(resolved.message, resolved.error)
    channelId = resolved.channelId
  } else {
    const pathId = ctx.params?.id
    if (typeof pathId !== "string" || !pathId || pathId === REF_PLACEHOLDER_ID) {
      return writeError("missing channel id", 400)
    }
    channelId = pathId
  }

  // Step 2 — the single mask (§3). DM block + opaque-404 folded in; the human
  // arm's known-but-non-member 403 is preserved.
  const access = await requireMessageSurfaceAccess(db, channelId, userId)
  if (!access.ok) return writeError(access.error, access.status)

  const message = await queries.communityMessage.getMessageByChannelAndSeq(db, { channelId }, seq)
  if (!message) {
    return writeJSON({ error: "not_found" }, 404)
  }

  return writeJSON({ id: message.id })
})
