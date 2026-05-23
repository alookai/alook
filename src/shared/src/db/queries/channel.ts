import { eq, and, asc, sql } from "drizzle-orm";
import { channel, conversation } from "../schema";
import type { Database } from "../index";

export async function createChannel(
  db: Database,
  data: { workspaceId: string; name: string }
) {
  const [maxRow] = await db
    .select({ maxPos: sql<number>`COALESCE(MAX(${channel.position}), -1)` })
    .from(channel)
    .where(eq(channel.workspaceId, data.workspaceId));
  const nextPos = (maxRow?.maxPos ?? -1) + 1;
  const rows = await db
    .insert(channel)
    .values({
      workspaceId: data.workspaceId,
      name: data.name,
      position: nextPos,
    })
    .returning();
  return rows[0]!;
}

export async function listChannels(db: Database, workspaceId: string) {
  return db
    .select()
    .from(channel)
    .where(eq(channel.workspaceId, workspaceId))
    .orderBy(asc(channel.position));
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

export async function getChannelById(
  db: Database,
  id: string,
  workspaceId: string
) {
  const rows = await db
    .select()
    .from(channel)
    .where(and(eq(channel.id, id), eq(channel.workspaceId, workspaceId)));
  return rows[0] ?? null;
}

export async function deleteChannel(
  db: Database,
  id: string,
  workspaceId: string
) {
  const row = await getChannelById(db, id, workspaceId);
  if (!row) return null;

  await db.batch([
    db
      .delete(conversation)
      .where(
        and(
          eq(conversation.workspaceId, workspaceId),
          eq(conversation.channel, row.name)
        )
      ),
    db
      .delete(channel)
      .where(and(eq(channel.id, id), eq(channel.workspaceId, workspaceId))),
  ]);

  return row;
}

export async function renameChannel(
  db: Database,
  id: string,
  workspaceId: string,
  newName: string
) {
  const row = await getChannelById(db, id, workspaceId);
  if (!row) return null;

  await db.batch([
    db
      .update(conversation)
      .set({ channel: newName })
      .where(
        and(
          eq(conversation.workspaceId, workspaceId),
          eq(conversation.channel, row.name)
        )
      ),
    db
      .update(channel)
      .set({ name: newName })
      .where(and(eq(channel.id, id), eq(channel.workspaceId, workspaceId))),
  ]);

  return { ...row, name: newName };
}

export async function reorderChannels(
  db: Database,
  workspaceId: string,
  orderedChannelIds: string[],
) {
  await (db as any).batch(
    orderedChannelIds.map((id, i) =>
      db
        .update(channel)
        .set({ position: i })
        .where(
          and(
            eq(channel.id, id),
            eq(channel.workspaceId, workspaceId),
          )
        )
    )
  );
}
