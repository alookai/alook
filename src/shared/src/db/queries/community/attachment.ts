import { eq, inArray } from "drizzle-orm";
import { communityAttachment } from "../../community-schema";
import type { Database } from "../../index";

export async function createAttachment(
  db: Database,
  data: {
    messageId: string;
    filename: string;
    url: string;
    contentType?: string;
    size?: number;
    width?: number;
    height?: number;
  }
) {
  const [row] = await db
    .insert(communityAttachment)
    .values({
      messageId: data.messageId,
      filename: data.filename,
      url: data.url,
      contentType: data.contentType ?? null,
      size: data.size ?? null,
      width: data.width ?? null,
      height: data.height ?? null,
    })
    .returning();
  return row!;
}

export async function listMessageAttachments(
  db: Database,
  messageId: string
) {
  return db
    .select()
    .from(communityAttachment)
    .where(eq(communityAttachment.messageId, messageId));
}

export async function listByMessageIds(
  db: Database,
  messageIds: string[]
) {
  if (messageIds.length === 0) return [];
  return db
    .select()
    .from(communityAttachment)
    .where(inArray(communityAttachment.messageId, messageIds));
}
