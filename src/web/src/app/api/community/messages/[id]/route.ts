import { NextRequest } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, MAX_MESSAGE_CONTENT_LENGTH, WS_EVENTS } from "@alook/shared"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"
import { resolveTargetForMember } from "@/lib/community/resolve-ref"
import { isDmTarget } from "@/lib/community/message-handler"
import { fanOutToChannel } from "@/lib/community/fanout"
import { groupAttachments, groupReactions } from "@/lib/community/messages"
import { mapMessageForApi } from "@/lib/community/message-payload"

// A bot addresses by ref-in-query (`?ref=` + `?seq=`, the folded `resolve`
// verb); the path `[id]` is then the `resolve` placeholder (a ref carries `/`
// and can't sit in a path segment). A human/web caller puts the real messageId
// in the path.
const REF_PLACEHOLDER_ID = "resolve"

/**
 * GET /api/community/messages/[id] — single fully-hydrated message.
 *
 * Dual-actor hydrate door (route/disc trunk — folds the `resolve` bot verb).
 * withCommunityActor serves human (session, id-in-path) + bot (crk_, ref+seq).
 * The response FORM forks by the credential actor (Aigneis ②, never a field):
 *   - human/web → `mapMessageForApi` (attachments + reactions + reply preview),
 *     the thread-opener block shape. Addressing: messageId in the path.
 *   - bot/CLI → `toAgentMessage` (the folded `resolve` verb's `{ message }`
 *     agent shape). Addressing: ref+seq — the bot holds a ref+seq, not an id,
 *     so `resolve` was never id-addressable (Gener #68).
 *
 * Authorization is credential-scoped and ①-C uniform:
 *   - human/id: getMessage → its channel → per-surface gate (requireDMAccess /
 *     requireChannelMember). known-but-non-member → 403, the 403/404 split web
 *     needs — byte-identical to the pre-fold route.
 *   - bot/ref: `resolveTargetForMember` FIRST (member-scoped inner-join → an
 *     unreachable channel is 0 rows → 404 BEFORE any message lookup), then the
 *     channel-scoped seq lookup. So a bot never sees a 403 disclosing a
 *     message/channel it can't reach (same ①-C mask as reactions/seq).
 * Both arms hydrate the SAME row (attachments + reply scoped to the message's
 * own surface); only the projection differs.
 */
export const GET = withCommunityActor(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  if (ctx.actor.kind === "bot") {
    return handleBotResolve(db, ctx.actor.userId, req)
  }
  return handleHumanGet(db, ctx.actor.userId, ctx.params?.id)
})

/** PATCH /api/community/messages/[id] — edit only the caller's own text.
 * Admin status never grants edit-as-author; attachments are intentionally not
 * part of this contract. */
export const PATCH = withCommunityActor(async (req: NextRequest, ctx) => {
  if (ctx.actor.kind !== "human") return writeError("human session required", 401)
  const messageId = ctx.params?.id
  if (!messageId || messageId === REF_PLACEHOLDER_ID) return writeError("missing message id", 400)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }
  const content = raw && typeof raw === "object" ? (raw as { content?: unknown }).content : undefined
  if (typeof content !== "string" || content.trim().length === 0) {
    return writeError("content is required", 400)
  }
  if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return writeError(`content must be ≤ ${MAX_MESSAGE_CONTENT_LENGTH} characters`, 400)
  }

  const db = getDb(ctx.env.DB)
  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return writeError("message not found", 404)

  const channelType = await queries.communityChannel.getChannelType(db, message.channelId)
  const access = channelType === "dm"
    ? await requireDMAccess(db, message.channelId, ctx.actor.userId)
    : await requireChannelMember(db, message.channelId, ctx.actor.userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (message.authorId !== ctx.actor.userId) return writeError("only the message author may edit it", 403)

  const updated = await queries.communityMessage.updateOwnMessageContent(db, {
    messageId,
    authorId: ctx.actor.userId,
    content,
  })
  if (!updated) return writeError("message not found", 404)
  // Forum openers live in the PARENT forum channel; the child post points back
  // to them via parentMessageId. Resolve through the same indexed relation as
  // the tags route instead of inspecting the parent row's own parentMessageId.
  const openerThread = channelType === "forum"
    ? await queries.communityChannel.getThreadChannelByParentMessage(db, message.channelId, messageId)
    : null
  const parentChannelId = openerThread?.type === "thread" ? message.channelId : undefined
  await fanOutToChannel(message.channelId, {
    type: WS_EVENTS.MESSAGE_EDITED,
    channelId: message.channelId,
    messageId,
    content,
    ...(parentChannelId ? { parentChannelId } : {}),
  })
  return writeJSON({ message: updated })
})

/**
 * Human arm — messageId in the path, `mapMessageForApi` shape. Unchanged from
 * the pre-fold route (the 403/404 split is a correct pre-existing contract).
 */
async function handleHumanGet(
  db: ReturnType<typeof getDb>,
  userId: string,
  messageId: string | undefined,
) {
  if (!messageId || messageId === REF_PLACEHOLDER_ID) return writeError("missing message id", 400)

  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return writeError("message not found", 404)

  // A DM is a `type=dm` channel — gate accordingly. Every other channel type
  // (including threads/forum posts) uses the server-scoped member gate.
  const channelType = await queries.communityChannel.getChannelType(db, message.channelId)
  if (channelType === "dm") {
    const auth = await requireDMAccess(db, message.channelId, userId)
    if (!auth.ok) return writeError(auth.error, auth.status)
  } else {
    const auth = await requireChannelMember(db, message.channelId, userId)
    if (!auth.ok) return writeError(auth.error, auth.status)
  }

  const [allAttachments, allReactions, replyMessages] = await Promise.all([
    queries.communityAttachment.listByMessageIds(db, [messageId]),
    queries.communityReaction.listReactionsByMessageIds(db, [messageId], userId),
    message.replyToId
      ? queries.communityMessage.getMessagesByIdsInScope(db, [message.replyToId], { channelId: message.channelId })
      : Promise.resolve([]),
  ])

  const attachmentsByMessage = groupAttachments(allAttachments)
  const reactionsByMessage = groupReactions(allReactions, userId)
  // Reply target already scoped to the SAME surface as the parent — a reply
  // preview must not leak content from a different channel/DM.
  const replyMap = new Map(replyMessages.map((m) => [m.id, m]))

  const payload = mapMessageForApi(message, { replyMap, attachmentsByMessage, reactionsByMessage })
  return writeJSON(payload)
}

/**
 * Bot arm — the folded `resolve` verb. ref+seq (query) → member-scoped resolve
 * (404-before-mask) → channel-scoped seq lookup → `toAgentMessage` shape.
 * Behavior byte-identical to the old flat `resolve` route (same gates, same
 * `{ message }` agent shape, same seq===0 legacy-sentinel 404).
 */
async function handleBotResolve(
  db: ReturnType<typeof getDb>,
  botUserId: string,
  req: NextRequest,
) {
  const params = req.nextUrl.searchParams
  const ref = params.get("ref")
  const seqRaw = params.get("seq")
  if (!ref) return writeError("channel ref required", 400)
  const seq = seqRaw === null ? NaN : Number(seqRaw)
  if (!Number.isInteger(seq)) return writeError("valid seq required", 400)
  // seq 0 is the legacy pre-migration sentinel — never a real message.
  if (seq === 0) return writeError("seq 0 is not a real message", 404)
  if (seq < 0) return writeError("valid seq required", 400)

  // Member-scoped resolve FIRST (unreachable → 404 before any lookup, ①-C). No
  // create-if-missing — resolve is pure addressing (resolve≠create).
  const resolved = await resolveTargetForMember(db, botUserId, ref, {
    createDmIfMissing: false,
    createThreadIfMissing: false,
    callerKind: "bot",
  })
  if ("error" in resolved) return writeError(resolved.message, resolved.error)

  const scopeTarget = { channelId: resolved.channelId }
  // Per-surface gate on the resolved channel (dispatch by surface; DM incl
  // block). resolveTargetForMember already member-scoped the resolve, so this
  // re-affirms access on the concrete channel — matching the old resolve route.
  if (isDmTarget(resolved)) {
    const gate = await requireDMAccess(db, resolved.channelId, botUserId)
    if (!gate.ok) return writeError(gate.error, gate.status)
  } else {
    const gate = await requireChannelMember(db, resolved.channelId, botUserId)
    if (!gate.ok) return writeError(gate.error, gate.status)
  }

  const row = await queries.communityMessage.getMessageByChannelAndSeq(db, scopeTarget, seq)
  if (!row) return writeError(`no message with seq #${seq} in ${ref}`, 404)

  const attachmentRows = await queries.communityAttachment.listByMessageIds(db, [row.id])
  const attachments = attachmentRows.map((a) => ({
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
  }))

  const message = await queries.communityAgentInbox.toAgentMessage(db, row, botUserId, attachments)
  return writeJSON({ message })
}
