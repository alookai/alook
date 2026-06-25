import { eq, and } from "drizzle-orm";
import {
  communityServerFolder,
  communityServerFolderItem,
} from "../../community-schema";
import type { Database } from "../../index";

export async function createFolder(
  db: Database,
  data: { userId: string; name: string; serverIds?: string[] }
) {
  const [folder] = await db
    .insert(communityServerFolder)
    .values({
      userId: data.userId,
      name: data.name,
    })
    .returning();

  if (data.serverIds && data.serverIds.length > 0) {
    await db.insert(communityServerFolderItem).values(
      data.serverIds.map((serverId, idx) => ({
        folderId: folder!.id,
        serverId,
        position: idx,
      }))
    );
  }

  return folder!;
}

export async function getFolder(
  db: Database,
  folderId: string,
  userId: string
) {
  const rows = await db
    .select()
    .from(communityServerFolder)
    .where(
      and(
        eq(communityServerFolder.id, folderId),
        eq(communityServerFolder.userId, userId)
      )
    );
  return rows[0] ?? null;
}

export async function updateFolder(
  db: Database,
  folderId: string,
  data: { name?: string }
) {
  if (data.name !== undefined) {
    await db
      .update(communityServerFolder)
      .set({ name: data.name })
      .where(eq(communityServerFolder.id, folderId));
  }
}

export async function replaceFolderItems(
  db: Database,
  folderId: string,
  serverIds: string[]
) {
  await db
    .delete(communityServerFolderItem)
    .where(eq(communityServerFolderItem.folderId, folderId));

  if (serverIds.length > 0) {
    await db.insert(communityServerFolderItem).values(
      serverIds.map((serverId, idx) => ({
        folderId,
        serverId,
        position: idx,
      }))
    );
  }
}

export async function deleteFolder(db: Database, folderId: string) {
  await db
    .delete(communityServerFolder)
    .where(eq(communityServerFolder.id, folderId));
}
