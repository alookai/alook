import { eq, and } from "drizzle-orm";
import type { Database } from "../index";
import { conversationMap } from "../schema";
import { nanoid } from "nanoid";

export async function findByKey(
  db: Database,
  key: string,
  workspaceId: string,
): Promise<string | null> {
  const rows = await db
    .select({ conversationId: conversationMap.conversationId })
    .from(conversationMap)
    .where(
      and(
        eq(conversationMap.key, key),
        eq(conversationMap.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return rows[0]?.conversationId ?? null;
}

export async function createMapping(
  db: Database,
  opts: { key: string; workspaceId: string; conversationId: string },
): Promise<void> {
  await db
    .insert(conversationMap)
    .values({
      id: nanoid(),
      key: opts.key,
      workspaceId: opts.workspaceId,
      conversationId: opts.conversationId,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
}
