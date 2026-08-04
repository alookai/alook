import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry, CommunityAgentCreatePostRequestSchema, formatCanonicalRef } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { requireChannelMember } from "@/lib/community/permissions"
import { createForumPost } from "@/lib/community/create-forum-post"

/**
 * POST /api/community/createPost — bot verb behind `alook message post`. Creates
 * a NEW forum post: body `{ forum, title, content, attachments?, nonce? }` where
 * `forum` is a forum REF (`/server/forum`, resolved server-side like `send`'s
 * `channel`). Bot-only (`requireBot`); a human posts via the web New-Post button
 * (the human `channels/[id]/posts` route). Both call the SAME `createForumPost`
 * core, so the two creation paths can't drift.
 *
 * Gate order (thread /Alook/discuss/#462, Aigneis's authz red-line): resolve the
 * forum ref (NO create flags — we don't auto-create a forum) → assert it IS a
 * forum → really run `requireChannelMember(forum, botUserId)` (the CREATE authz
 * gate — a bot may create a post only in a forum it can access, same as a human;
 * a non-member 403s, NOT a requireBot shortcut) → createForumPost. NO alignment
 * gate: a fresh post is a new scope with no seq contention.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const gate0 = requireBot(ctx.actor)
  if (!gate0.ok) return gate0.response
  const botUserId = gate0.bot.userId

  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentCreatePostRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }
  const body = parsed.data

  // Resolve the forum ref WITHOUT create flags — a stale/typo ref must 404, never
  // materialize a channel. `/server/forum` resolves to the forum's own channel.
  const resolved = await resolveTargetForMember(db, botUserId, body.forum)
  if ("error" in resolved) return resolveErrorResponse(resolved)
  if (resolved.kind !== "channel") {
    return NextResponse.json({ error: "target is not a forum" }, { status: 400 })
  }

  // Authz gate = the SAME requireChannelMember(forum) a human create passes — a
  // bot creates a post only in a forum it can access (non-member → 403). This is
  // the create authorization gate, distinct from requireBot (which only answers
  // "is a bot") and from resolveTargetForMember's membership-scoped addressing.
  const gate = await requireChannelMember(db, resolved.channelId, botUserId)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const forum = gate.value
  if (forum.type !== "forum") {
    return NextResponse.json({ error: "target is not a forum" }, { status: 400 })
  }

  // Attachment ownership (坑1): a bot uploads a pending attachment BEFORE the post
  // channel exists, so it binds the pending row's `target_id` to the FORUM id.
  // Validate ownership against that forum id here (the widen: bind-to-forum for a
  // post, vs `send`'s bind-to-channel — the post channel doesn't exist yet at
  // upload time). This is the authorization check; the actual reservation
  // (`reserveAttachmentsForMessage`, inside createForumPost's first-message send)
  // then binds each pending row to the new message BY ID, so no target re-point
  // is needed — the forum-ownership gate is enforced right here, up front. A
  // mismatch → generic 400, no leak of which id failed.
  if (body.attachments.length > 0) {
    const rows = await withD1Retry(
      () => queries.communityAttachment.findPendingAttachmentsForBot(db, {
        ids: body.attachments,
        uploaderId: botUserId,
        targetId: resolved.channelId,
      }),
      { route: "community/createPost:attachments" },
    )
    if (rows.length !== body.attachments.length) {
      return NextResponse.json(
        { error: "attachment not found or not attachable to this forum" },
        { status: 400 },
      )
    }
  }

  const result = await createForumPost({
    db,
    forumChannelId: forum.id,
    serverId: forum.serverId!,
    authorId: botUserId,
    rawTitle: body.title,
    content: body.content.text,
    attachmentIds: body.attachments.length > 0 ? body.attachments : undefined,
    clientNonce: body.nonce,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  // Return the canonical, addressable ref of the created post — `/server/forum/
  // <real-slug>` (the slug after dedupe/bump), which the bot can hand straight
  // back as a `--target`. Built by the single canonical-ref emitter (B1), the
  // same one inbox/send resolve against, so it round-trips by construction.
  const server = await withD1Retry(
    () => queries.communityServer.getServer(db, forum.serverId!),
    { route: "community/createPost:server" },
  )
  const serverName = server?.name ?? null
  const ref = serverName
    ? formatCanonicalRef({
        type: "forum_post",
        serverName,
        parentName: forum.name ?? undefined,
        name: result.postChannel.name,
      })
    : null

  return NextResponse.json({
    post: {
      ref,
      name: result.postChannel.name,
      seq: result.messageRow.seq,
    },
  }, { status: 201 })
})
