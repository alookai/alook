import { NextResponse } from "next/server"
import { COMMUNITY_RESOURCE_CONTRACT_VERSION, MAX_MESSAGE_CONTENT_LENGTH, queries, type CommunityContract, type Database } from "@alook/shared"
import { putAttachmentContent } from "./upload"
import { handleHumanSend } from "./message-send.server"

type PageBinding = NonNullable<Awaited<ReturnType<typeof queries.communityPage.getReadablePage>>>

export async function sendPageComment(
  db: Database,
  userId: string,
  env: Env,
  page: PageBinding,
  input: { text: string; location?: string; nonce?: string },
  contract: CommunityContract = COMMUNITY_RESOURCE_CONTRACT_VERSION,
) {
  const bot = await queries.user.getUserPublic(db, page.sourceBotId)
  const thread = page.channelType === "forum"
    ? await queries.communityChannel.getThreadChannelByParentMessage(db, page.channelId, page.messageId)
    : null
  if (page.channelType === "forum" && !thread) return NextResponse.json({ error: "Page conversation not found" }, { status: 404 })
  const channelId = thread?.id ?? page.channelId
  const content = [
    bot ? `@${bot.name}#${bot.discriminator} · Alook Page ${page.id}` : `Alook Page ${page.id}`,
    ...(input.location ? [`Location: ${input.location}`] : []), input.text,
  ].join("\n\n")
  const long = content.length > MAX_MESSAGE_CONTENT_LENGTH
  const prepare = async () => {
    const file = new File([content], "page-feedback.md", { type: "text/markdown" })
    const r2Key = await putAttachmentContent(env.COMMUNITY_MEDIA, file, "attachments")
    const attachment = await queries.communityAttachment.createAttachment(db, { uploaderId: userId, r2Key, filename: file.name, contentType: file.type, size: file.size })
    const suffix = "\n\nFull feedback is attached."
    return { content: content.slice(0, MAX_MESSAGE_CONTENT_LENGTH - suffix.length) + suffix, attachments: [attachment.id] }
  }
  const body = {
    content, ...(input.nonce ? { nonce: input.nonce } : {}), ...(channelId === page.channelId ? { replyToId: page.messageId } : {}),
  }
  return long ? handleHumanSend(db, userId, env, { id: channelId }, body, contract, { prepare })
    : handleHumanSend(db, userId, env, { id: channelId }, body, contract)
}
