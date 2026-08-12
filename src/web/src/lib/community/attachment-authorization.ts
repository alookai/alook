import { queries, type Database } from "@alook/shared"
import type { CommunityActor } from "@/lib/middleware/community-actor"
import { requireChannelMember, requireDMAccess } from "./permissions"

type AuthzOk = {
  ok: true
  row: NonNullable<Awaited<ReturnType<typeof queries.communityAttachment.getAttachmentById>>>
}

/** Authorize solely from the attachment row; route target ids are never trusted. */
export async function authorizeAttachment(
  actor: CommunityActor,
  db: Database,
  attachmentId: string,
): Promise<AuthzOk | { ok: false }> {
  const userId = actor.userId
  const row = await queries.communityAttachment.getAttachmentById(db, attachmentId)
  if (!row) return { ok: false }

  if (row.messageId === null) {
    return row.uploaderId === userId ? { ok: true, row } : { ok: false }
  }

  const message = await queries.communityMessage.getMessage(db, row.messageId)
  if (!message) return { ok: false }
  const channelType = await queries.communityChannel.getChannelType(db, message.channelId)
  const gate = channelType === "dm"
    ? await requireDMAccess(db, message.channelId, userId)
    : await requireChannelMember(db, message.channelId, userId)
  return gate.ok ? { ok: true, row } : { ok: false }
}
