import { emails } from "../schema";
import type { Database } from "../index";
import type { EmailDirection } from "../../types";

export async function createEmail(
  db: Database,
  data: { agentId: string; workspaceId: string; fromEmail: string; toEmail: string; subject: string; r2Key: string; isWhitelisted: boolean; forwarded: boolean; direction: EmailDirection; messageId?: string; inReplyTo?: string; references?: string; htmlBody?: string; attachments?: string; status?: string }
) {
  const rows = await db.insert(emails).values(data).returning();
  return rows[0]!;
}
