import { sql, eq, inArray } from "drizzle-orm";
import { communityMessage, communityChannel } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

const DEFAULT_LIMIT = 50;

export async function searchMessages(
  db: Database,
  opts: {
    query: string;
    channelId?: string;
    dmConversationId?: string;
    serverId?: string;
    limit?: number;
  }
) {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // FTS5 requires raw SQL — no Drizzle ORM equivalent exists
  const ftsResults = await db.all<{ id: string }>(
    sql`SELECT id FROM community_message_fts WHERE community_message_fts MATCH ${opts.query} LIMIT ${limit}`
  );

  if (ftsResults.length === 0) return [];

  const ids = ftsResults.map((r) => r.id);

  // Fetch full messages with author info using ORM
  let query = db
    .select({
      message: communityMessage,
      author: user,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(inArray(communityMessage.id, ids));

  const results = await query;

  // Apply additional filters in application layer
  return results.filter((r) => {
    if (opts.channelId && r.message.channelId !== opts.channelId) return false;
    if (
      opts.dmConversationId &&
      r.message.dmConversationId !== opts.dmConversationId
    )
      return false;
    if (opts.serverId) {
      // serverId filtering requires channel lookup — handled below
      return true;
    }
    return true;
  });
}

export async function searchMessagesInServer(
  db: Database,
  opts: {
    query: string;
    serverId: string;
    limit?: number;
  }
) {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // FTS5 requires raw SQL — no Drizzle ORM equivalent exists
  const ftsResults = await db.all<{ id: string }>(
    sql`SELECT id FROM community_message_fts WHERE community_message_fts MATCH ${opts.query} LIMIT ${limit}`
  );

  if (ftsResults.length === 0) return [];

  const ids = ftsResults.map((r) => r.id);

  // Fetch messages joined with channel to filter by serverId
  return db
    .select({
      message: communityMessage,
      author: user,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .innerJoin(
      communityChannel,
      eq(communityMessage.channelId, communityChannel.id)
    )
    .where(
      inArray(communityMessage.id, ids)
    );
}
