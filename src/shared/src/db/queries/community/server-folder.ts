import { and, eq } from "drizzle-orm";
import { communityServer, communityServerMember } from "../../community-schema";
import type { Database } from "../../index";
import { serverRailTopOrder } from "../../../community-server-rail";
import { readServerRailSnapshot } from "./server-rail";

export async function listFolders(db: Database, userId: string) {
  const [state, servers] = await Promise.all([
    readServerRailSnapshot(db, userId),
    db.select({ id: communityServer.id, name: communityServer.name, icon: communityServer.icon })
      .from(communityServer)
      .innerJoin(communityServerMember, and(eq(communityServerMember.serverId, communityServer.id), eq(communityServerMember.userId, userId))),
  ]);
  const byId = new Map(servers.map((server) => [server.id, server]));
  const topOrder = serverRailTopOrder(state);
  const folders = topOrder.flatMap((entry) => {
    if (entry.kind !== "folder") return [];
    const folder = state.folders[entry.id]!;
    return [{ id: folder.id, name: folder.name, servers: folder.serverIds.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []) }];
  });
  return { folders, topOrder };
}
