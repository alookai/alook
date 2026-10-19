import { eq, asc } from "drizzle-orm";
import {
  communityServerFolder,
  communityServerFolderItem,
  communityServer,
} from "../../community-schema";
import type { Database } from "../../index";
export async function listFolders(db: Database, userId: string) {
  const folderRows = await db
    .select()
    .from(communityServerFolder)
    .where(eq(communityServerFolder.userId, userId))
    .orderBy(asc(communityServerFolder.position));

  const folders = await Promise.all(
    folderRows.map(async (folder) => {
      const items = await db
        .select({
          serverId: communityServerFolderItem.serverId,
          position: communityServerFolderItem.position,
          serverName: communityServer.name,
          serverIcon: communityServer.icon,
        })
        .from(communityServerFolderItem)
        .leftJoin(communityServer, eq(communityServerFolderItem.serverId, communityServer.id))
        .where(eq(communityServerFolderItem.folderId, folder.id))
        .orderBy(asc(communityServerFolderItem.position));

      return {
        id: folder.id,
        name: folder.name,
        position: folder.position ?? 0,
        servers: items.map((item) => ({
          id: item.serverId,
          name: item.serverName ?? "Server unavailable",
          icon: item.serverIcon ?? null,
        })),
      };
    })
  );

  return folders;
}
