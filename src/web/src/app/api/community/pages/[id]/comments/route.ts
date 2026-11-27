import { NextResponse } from "next/server"
import { AlookPageCommentSchema, COMMUNITY_RESOURCE_CONTRACT_VERSION, queries, readBoundedJsonRequest, requestedCommunityContract } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth-policy"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { handleHumanSend } from "@/lib/community/message-send.server"

export const POST = withAuth(humanAuthPolicy, async (req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  const page = await queries.communityPage.getReadablePage(db, ctx.params!.id!, ctx.userId)
  if (!page) return NextResponse.json({ error: "Page not found" }, { status: 404 })
  const raw = await readBoundedJsonRequest(req, 64 * 1024)
  if (!raw.ok) return NextResponse.json({ error: "Invalid Page comment" }, { status: raw.reason === "oversized" ? 413 : 400 })
  const body = AlookPageCommentSchema.safeParse(raw.value)
  if (!body.success) return NextResponse.json({ error: "Invalid Page comment" }, { status: 400 })
  const bot = await queries.user.getUserPublic(db, page.botId)
  const thread = page.channelType === "forum"
    ? await queries.communityChannel.getThreadChannelByParentMessage(db, page.channelId, page.messageId)
    : null
  if (page.channelType === "forum" && !thread) return NextResponse.json({ error: "Page conversation not found" }, { status: 404 })
  const channelId = thread?.id ?? page.channelId
  const content = [
    bot ? `@${bot.name}#${bot.discriminator} · Alook Page ${page.id}` : `Alook Page ${page.id}`,
    ...(body.data.location ? [`Location: ${body.data.location}`] : []),
    body.data.text,
  ].join("\n\n")
  return handleHumanSend(db, ctx.userId, ctx.env, { id: channelId }, {
    content, ...(channelId === page.channelId ? { replyToId: page.messageId } : {}),
  }, requestedCommunityContract(req.headers) ?? COMMUNITY_RESOURCE_CONTRACT_VERSION)
})
