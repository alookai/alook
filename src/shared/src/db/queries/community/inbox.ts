import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  communityChannel,
  communityReadState,
  communityServer,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";

export interface UnreadChannelRow {
  channelId: string;
  channelName: string;
  serverId: string;
  serverName: string;
  lastMessageAt: string;
  lastReadAt: string | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Unreads
// ──────────────────────────────────────────────────────────────────────────────

export async function listUnreadChannels(
  db: Database,
  userId: string
): Promise<UnreadChannelRow[]> {
  // All top-level channels in servers the user is a member of, plus read state.
  // Filtering by lastMessageAt > lastReadAt happens in JS so we can keep one query.
  const rows = await db
    .select({
      channelId: communityChannel.id,
      channelName: communityChannel.name,
      serverId: communityChannel.serverId,
      serverName: communityServer.name,
      lastMessageAt: communityChannel.lastMessageAt,
      lastReadAt: communityReadState.lastReadAt,
      archived: communityChannel.archived,
    })
    .from(communityServerMember)
    .innerJoin(
      communityChannel,
      eq(communityChannel.serverId, communityServerMember.serverId)
    )
    .innerJoin(communityServer, eq(communityServer.id, communityChannel.serverId))
    .leftJoin(
      communityReadState,
      and(
        eq(communityReadState.channelId, communityChannel.id),
        eq(communityReadState.userId, userId)
      )
    )
    .where(
      and(
        eq(communityServerMember.userId, userId),
        isNull(communityChannel.parentChannelId),
        isNotNull(communityChannel.lastMessageAt)
      )
    );

  return rows
    .filter((r) => {
      if (r.archived) return false;
      if (!r.lastMessageAt) return false;
      if (!r.lastReadAt) return true;
      return r.lastMessageAt > r.lastReadAt;
    })
    .map((r) => ({
      channelId: r.channelId,
      channelName: r.channelName,
      serverId: r.serverId,
      serverName: r.serverName,
      lastMessageAt: r.lastMessageAt!,
      lastReadAt: r.lastReadAt,
    }));
}
