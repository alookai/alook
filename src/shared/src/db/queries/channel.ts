import { eq, and } from "drizzle-orm";
import { channel } from "../schema";
import type { Database } from "../index";

export async function createChannel(
  db: Database,
  data: { workspaceId: string; name: string }
) {
  const rows = await db
    .insert(channel)
    .values({
      workspaceId: data.workspaceId,
      name: data.name,
    })
    .returning();
  return rows[0]!;
}

export async function listChannels(db: Database, workspaceId: string) {
  return db
    .select()
    .from(channel)
    .where(eq(channel.workspaceId, workspaceId));
}

export async function getChannelByName(
  db: Database,
  workspaceId: string,
  name: string
) {
  const rows = await db
    .select()
    .from(channel)
    .where(
      and(eq(channel.workspaceId, workspaceId), eq(channel.name, name))
    );
  return rows[0] ?? null;
}
