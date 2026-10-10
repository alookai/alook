import { queries, type Database } from "@alook/shared"
import type { CommunityActor } from "@/lib/middleware/community-actor"

export async function authorizeAttachment(actor: CommunityActor, db: Database, attachmentId: string) {
  const row = await queries.communityAttachment.getReadableAttachmentById(db, attachmentId, actor.userId)
  return row ? { ok: true as const, row } : { ok: false as const }
}
