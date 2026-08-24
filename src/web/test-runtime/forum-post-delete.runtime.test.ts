/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, queries } from "@alook/shared";

const runtimeEnv = env as unknown as CloudflareEnv;
const createdServers: string[] = [];
const createdUsers: string[] = [];

async function run(statement: string, ...bindings: unknown[]): Promise<void> {
  await runtimeEnv.DB.prepare(statement).bind(...bindings).run();
}

async function first<T>(statement: string, ...bindings: unknown[]): Promise<T | null> {
  return runtimeEnv.DB.prepare(statement).bind(...bindings).first<T>();
}

async function all<T>(statement: string, ...bindings: unknown[]): Promise<T[]> {
  const result = await runtimeEnv.DB.prepare(statement).bind(...bindings).all<T>();
  return result.results;
}

function ids() {
  const stamp = crypto.randomUUID().replaceAll("-", "");
  return {
    owner: `fpd_owner_${stamp}`,
    reader: `fpd_reader_${stamp}`,
    server: `fpd_server_${stamp}`,
    forum: `fpd_forum_${stamp}`,
    opener: `fpd_opener_${stamp}`,
    prior: `fpd_prior_${stamp}`,
    siblingOpener: `fpd_sibling_opener_${stamp}`,
    child: `fpd_child_${stamp}`,
    siblingChild: `fpd_sibling_child_${stamp}`,
    reply: `fpd_reply_${stamp}`,
  };
}

async function seedCanonicalPost() {
  const id = ids();
  createdServers.push(id.server);
  createdUsers.push(id.owner, id.reader);
  const t1 = "2026-08-23T01:00:00.000Z";
  const t2 = "2026-08-23T01:01:00.000Z";
  const t3 = "2026-08-23T01:02:00.000Z";
  const childTime = "2026-08-23T01:03:00.000Z";

  await run("INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Owner', ?)", id.owner, `${id.owner}@example.com`, stamp4(id.owner));
  await run("INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Reader', ?)", id.reader, `${id.reader}@example.com`, stamp4(id.reader));
  await run(
    "INSERT INTO community_server (id, name, description, owner_id, created_at, discriminator) VALUES (?, ?, '', ?, ?, ?)",
    id.server,
    id.server,
    id.owner,
    t1,
    stamp4(id.server),
  );
  await run(
    `INSERT INTO community_channel
      (id, server_id, name, type, message_count, last_message_at, created_at)
     VALUES (?, ?, 'forum-delete', 'forum', 3, ?, ?)`,
    id.forum,
    id.server,
    t3,
    t1,
  );
  await run(
    `INSERT INTO community_message
      (id, author_id, content, created_at, channel_id, seq)
     VALUES (?, ?, 'prior', ?, ?, 1), (?, ?, 'sibling', ?, ?, 2), (?, ?, 'delete me', ?, ?, 3)`,
    id.prior, id.owner, t1, id.forum,
    id.siblingOpener, id.owner, t2, id.forum,
    id.opener, id.owner, t3, id.forum,
  );
  await run(
    `INSERT INTO community_channel
      (id, server_id, name, type, parent_channel_id, creator_id, message_count,
       parent_message_id, last_message_at, created_at)
     VALUES (?, ?, 'delete child', 'thread', ?, ?, 1, ?, ?, ?),
            (?, ?, 'sibling child', 'thread', ?, ?, 0, ?, NULL, ?)`,
    id.child, id.server, id.forum, id.owner, id.opener, childTime, childTime,
    id.siblingChild, id.server, id.forum, id.owner, id.siblingOpener, childTime,
  );
  await run(
    `INSERT INTO community_message
      (id, author_id, content, created_at, channel_id, seq)
     VALUES (?, ?, 'reply', ?, ?, 1)`,
    id.reply,
    id.reader,
    childTime,
    id.child,
  );
  await run(
    `INSERT INTO community_read_state
      (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq)
     VALUES (?, ?, ?, ?, ?, 3), (?, ?, ?, ?, ?, 3)`,
    `rs_owner_${id.opener}`, id.owner, id.forum, t3, id.opener,
    `rs_reader_${id.opener}`, id.reader, id.forum, t3, id.opener,
  );
  await run(
    `INSERT INTO community_attachment
      (id, message_id, uploader_id, target_id, r2_key, thumbnail_r2_key, filename, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'opener.png', ?),
            (?, ?, ?, ?, ?, ?, 'reply.png', ?),
            (?, NULL, ?, ?, ?, ?, 'pending.png', ?)`,
    `att_opener_${id.opener}`, id.opener, id.owner, id.child, `${id.opener}/original`, `${id.opener}/thumb`, t3,
    `att_reply_${id.opener}`, id.reply, id.reader, id.child, `${id.reply}/original`, `${id.reply}/thumb`, childTime,
    `att_pending_${id.opener}`, id.owner, id.child, `${id.child}/pending-original`, `${id.child}/pending-thumb`, childTime,
  );
  await run(
    `INSERT INTO community_channel_member
      (id, channel_id, user_id, relation, source, added_at)
     VALUES (?, ?, ?, 'notify', 'spoke', ?)`,
    `participant_${id.opener}`, id.child, id.reader, childTime,
  );
  await run(
    `INSERT INTO community_read_state
      (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq)
     VALUES (?, ?, ?, ?, ?, 1)`,
    `rs_child_${id.opener}`, id.reader, id.child, childTime, id.reply,
  );
  await run(
    `INSERT INTO community_pin (id, channel_id, message_id, pinned_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    `pin_${id.opener}`, id.child, id.reply, id.owner, childTime,
  );
  await run(
    `INSERT INTO community_mention (id, message_id, user_id, kind, read)
     VALUES (?, ?, ?, 'mention', 0)`,
    `mention_${id.opener}`, id.reply, id.owner,
  );
  await run(
    `INSERT INTO community_message_mark (id, user_id, channel_id, message_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    `mark_${id.opener}`, id.reader, id.child, id.reply, childTime,
  );
  await run(
    `INSERT INTO community_message_tag (id, message_id, tag)
     VALUES (?, ?, 'delete-me')`,
    `tag_${id.opener}`, id.opener,
  );
  await run(
    `INSERT INTO community_reaction (id, message_id, user_id, emoji, created_at)
     VALUES (?, ?, ?, 'x', ?)`,
    `reaction_${id.opener}`, id.reply, id.owner, childTime,
  );
  return { id, t2 };
}

async function snapshotDestructiveAuthority(
  id: ReturnType<typeof ids>,
  userIds: string[],
) {
  const userPlaceholders = userIds.map(() => "?").join(", ");
  return {
    channels: await all(
      `SELECT id, parent_channel_id, parent_message_id, message_count, last_message_at
       FROM community_channel
       WHERE id IN (?, ?)
       ORDER BY id`,
      id.forum,
      id.child,
    ),
    messages: await all(
      `SELECT id, channel_id, seq
       FROM community_message
       WHERE id IN (?, ?)
       ORDER BY id`,
      id.opener,
      id.reply,
    ),
    readStates: await all(
      `SELECT user_id, channel_id, last_read_message_id, last_read_seq, last_read_at
       FROM community_read_state
       WHERE user_id IN (${userPlaceholders})
         AND channel_id IN (?, ?)
       ORDER BY user_id, channel_id`,
      ...userIds,
      id.forum,
      id.child,
    ),
    mentions: await all(
      `SELECT message_id, user_id, read
       FROM community_mention
       WHERE user_id IN (${userPlaceholders})
         AND message_id IN (?, ?)
       ORDER BY user_id, message_id`,
      ...userIds,
      id.opener,
      id.reply,
    ),
    revisions: await all(
      `SELECT user_id, revision
       FROM community_read_state_revision
       WHERE user_id IN (${userPlaceholders})
       ORDER BY user_id`,
      ...userIds,
    ),
  };
}

function stamp4(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) % 10_000;
  return String(hash).padStart(4, "0");
}

afterEach(async () => {
  for (const serverId of createdServers.splice(0)) {
    await runtimeEnv.DB.prepare("DELETE FROM community_server WHERE id = ?").bind(serverId).run();
  }
  for (const userId of createdUsers.splice(0)) {
    await runtimeEnv.DB.prepare("DELETE FROM user WHERE id = ?").bind(userId).run();
  }
});

describe("deleteForumPost real D1 batch", () => {
  it("versions mention-only owners and repairs every ordinary pointer in one delete batch", async () => {
    const { id, t2 } = await seedCanonicalPost();
    const mentionOnly = `fpd_mention_${crypto.randomUUID().replaceAll("-", "")}`;
    createdUsers.push(mentionOnly);
    await run(
      "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Mention', ?)",
      mentionOnly,
      `${mentionOnly}@example.com`,
      stamp4(mentionOnly),
    );
    await run(
      `INSERT INTO community_mention (id, message_id, user_id, kind, read)
       VALUES (?, ?, ?, 'mention', 0)`,
      `mention_only_${id.opener}`,
      id.opener,
      mentionOnly,
    );

    const db = createDb(runtimeEnv.DB);
    const result = await queries.communityMessage.hardDeleteMessage(db, id.opener);

    expect(new Set(result?.readStateRevisions.map((row) => row.userId))).toEqual(
      new Set([id.owner, id.reader, mentionOnly]),
    );
    for (const userId of [id.owner, id.reader]) {
      expect(await first<{ lastReadMessageId: string; lastReadSeq: number }>(
        `SELECT last_read_message_id AS lastReadMessageId,
                last_read_seq AS lastReadSeq
         FROM community_read_state
         WHERE user_id = ? AND channel_id = ?`,
        userId,
        id.forum,
      )).toEqual({ lastReadMessageId: id.siblingOpener, lastReadSeq: 2 });
    }
    await expect(queries.communityReadState.getAccountReadStateSnapshot(
      db,
      mentionOnly,
    )).resolves.toEqual({
      revision: 1,
      readStates: [],
    });
    expect(await first("SELECT id FROM community_message WHERE id = ?", id.opener)).toBeNull();
    expect(await first<{ message_count: number; last_message_at: string }>(
      "SELECT message_count, last_message_at FROM community_channel WHERE id = ?",
      id.forum,
    )).toEqual({ message_count: 2, last_message_at: t2 });
  });

  it("captures all media keys, repairs parent truth, and cascades only the selected post", async () => {
    const { id, t2 } = await seedCanonicalPost();
    const db = createDb(runtimeEnv.DB);

    const result = await queries.communityForumPostDelete.deleteForumPost(db, {
      openerId: id.opener,
      openerSeq: 3,
      forumChannelId: id.forum,
      childChannelId: id.child,
    });

    expect(result.deleted).toBe(true);
    expect(new Set(result.mediaKeys)).toEqual(new Set([
      `${id.opener}/original`,
      `${id.opener}/thumb`,
      `${id.reply}/original`,
      `${id.reply}/thumb`,
      `${id.child}/pending-original`,
      `${id.child}/pending-thumb`,
    ]));
    expect(await first<{ message_count: number; last_message_at: string }>(
      "SELECT message_count, last_message_at FROM community_channel WHERE id = ?",
      id.forum,
    )).toEqual({ message_count: 2, last_message_at: t2 });
    expect(await first("SELECT id FROM community_channel WHERE id = ?", id.child)).toBeNull();
    expect(await first("SELECT id FROM community_message WHERE id IN (?, ?)", id.opener, id.reply)).toBeNull();
    expect(await first("SELECT id FROM community_attachment WHERE target_id = ?", id.child)).toBeNull();
    for (const [table, rowId] of [
      ["community_channel_member", `participant_${id.opener}`],
      ["community_read_state", `rs_child_${id.opener}`],
      ["community_pin", `pin_${id.opener}`],
      ["community_mention", `mention_${id.opener}`],
      ["community_message_mark", `mark_${id.opener}`],
      ["community_message_tag", `tag_${id.opener}`],
      ["community_reaction", `reaction_${id.opener}`],
    ] as const) {
      expect(await first(`SELECT id FROM ${table} WHERE id = ?`, rowId), table).toBeNull();
    }
    expect(await first<{ last_read_message_id: string; last_read_seq: number; last_read_at: string }>(
      "SELECT last_read_message_id, last_read_seq, last_read_at FROM community_read_state WHERE user_id = ? AND channel_id = ?",
      id.reader,
      id.forum,
    )).toEqual({
      last_read_message_id: id.siblingOpener,
      last_read_seq: 2,
      last_read_at: t2,
    });
    expect(result.readStateRevisions).toHaveLength(2);
    for (const revision of result.readStateRevisions) {
      expect(revision.revision).toBe(1);
      await expect(queries.communityReadState.getAccountReadStateSnapshot(
        db,
        revision.userId,
      )).resolves.toEqual({
        revision: 1,
        readStates: [{
          channelId: id.forum,
          lastReadMessageId: id.siblingOpener,
          lastReadSeq: 2,
          lastReadAt: t2,
        }],
      });
    }
    expect(new Set(result.readStateRevisions.map((revision) => revision.userId))).toEqual(
      new Set([id.owner, id.reader]),
    );
    expect(await first("SELECT id FROM community_channel WHERE id = ?", id.siblingChild)).not.toBeNull();
    expect(await first("SELECT id FROM community_message WHERE id = ?", id.siblingOpener)).not.toBeNull();
  });

  it("makes a delete-first/read-second race a generic no-op without reviving an orphan cursor", async () => {
    const { id } = await seedCanonicalPost();
    await run(
      `INSERT INTO community_mention (id, message_id, user_id, kind, read)
       VALUES (?, ?, ?, 'mention', 0)`,
      `mention_prior_${id.opener}`,
      id.prior,
      id.owner,
    );
    const target = await first<{
      id: string;
      channelId: string;
      createdAt: string;
      seq: number;
    }>(
      `SELECT id, channel_id AS channelId, created_at AS createdAt, seq
       FROM community_message WHERE id = ?`,
      id.opener,
    );
    expect(target).not.toBeNull();

    const db = createDb(runtimeEnv.DB);
    await expect(queries.communityForumPostDelete.deleteForumPost(db, {
      openerId: id.opener,
      openerSeq: 3,
      forumChannelId: id.forum,
      childChannelId: id.child,
    })).resolves.toMatchObject({ deleted: true });

    const beforeSnapshot = await queries.communityReadState.getAccountReadStateSnapshot(db, id.owner);
    const beforeMention = await first<{ read: number }>(
      "SELECT read FROM community_mention WHERE message_id = ? AND user_id = ?",
      id.prior,
      id.owner,
    );
    const targetExists = queries.communityReadState.canonicalReadTargetExistsCondition(db, target!);
    const results = await db.batch([
      queries.communityReadState.advanceReadStateRevisionWhenAnyBuilder(
        db,
        id.owner,
        [
          queries.communityReadState.readStateAdvancesCondition(db, {
            userId: id.owner,
            channelId: id.forum,
            targetSeq: target!.seq,
          }, targetExists),
          queries.communityMention.unreadChannelMentionThroughSeqCondition(
            db,
            id.owner,
            id.forum,
            target!.seq,
            targetExists,
          ),
        ],
      ),
      queries.communityReadState.markReadToExistingMessageBuilder(db, {
        userId: id.owner,
        channelId: id.forum,
        message: target!,
      }),
      queries.communityMention.markChannelMentionsReadBuilder(
        db,
        id.owner,
        id.forum,
        target!.seq,
        targetExists,
      ),
      queries.communityReadState.accountReadStateRevisionBuilder(db, id.owner),
    ] as any) as unknown[];

    expect(results[0]).toEqual([]);
    await expect(queries.communityReadState.getAccountReadStateSnapshot(db, id.owner))
      .resolves.toEqual(beforeSnapshot);
    expect(await first<{ read: number }>(
      "SELECT read FROM community_mention WHERE message_id = ? AND user_id = ?",
      id.prior,
      id.owner,
    )).toEqual(beforeMention);
    expect(await first(
      `SELECT rs.id
       FROM community_read_state AS rs
       LEFT JOIN community_message AS message
         ON message.id = rs.last_read_message_id
       WHERE rs.user_id = ? AND message.id IS NULL`,
      id.owner,
    )).toBeNull();
  });

  it.each([
    ["parent repair", "community_read_state"],
    ["child cascade", "community_channel"],
  ] as const)("rolls back the whole combined delete when the %s statement fails", async (_label, failureScope) => {
    const { id } = await seedCanonicalPost();
    const foreign = `fpd_foreign_${crypto.randomUUID().replaceAll("-", "")}`;
    createdUsers.push(foreign);
    await run(
      "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Foreign', ?)",
      foreign,
      `${foreign}@example.com`,
      stamp4(foreign),
    );

    // A owns the parent pointer, child pointer, and mentions on both sides.
    await run(
      `INSERT INTO community_read_state
        (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq)
       VALUES (?, ?, ?, '2026-08-23T01:03:00.000Z', ?, 1)`,
      `rs_owner_child_${id.opener}`,
      id.owner,
      id.child,
      id.reply,
    );
    await run(
      `INSERT INTO community_mention (id, message_id, user_id, kind, read)
       VALUES (?, ?, ?, 'mention', 0)`,
      `mention_parent_${id.opener}`,
      id.opener,
      id.owner,
    );
    // B is child-only; foreign owns no scoped authority.
    await run(
      "DELETE FROM community_read_state WHERE user_id = ? AND channel_id = ?",
      id.reader,
      id.forum,
    );

    const audience = [id.owner, id.reader, foreign];
    const before = await snapshotDestructiveAuthority(id, audience);
    const triggerName = `force_fpd_${failureScope}_${crypto.randomUUID().replaceAll("-", "")}`;
    const triggerSql = failureScope === "community_read_state"
      ? `CREATE TRIGGER ${triggerName}
         BEFORE UPDATE ON community_read_state
         WHEN OLD.channel_id = '${id.forum}'
           AND OLD.last_read_message_id = '${id.opener}'
         BEGIN SELECT RAISE(ABORT, 'forced parent statement failure'); END`
      : `CREATE TRIGGER ${triggerName}
         BEFORE DELETE ON community_channel
         WHEN OLD.id = '${id.child}'
         BEGIN SELECT RAISE(ABORT, 'forced child statement failure'); END`;

    await run(triggerSql);
    try {
      const db = createDb(runtimeEnv.DB);
      await expect(queries.communityForumPostDelete.deleteForumPost(db, {
        openerId: id.opener,
        openerSeq: 3,
        forumChannelId: id.forum,
        childChannelId: id.child,
      })).rejects.toThrow(failureScope === "community_read_state"
        ? "forced parent statement failure"
        : "forced child statement failure");

      expect(await snapshotDestructiveAuthority(id, audience)).toEqual(before);
      expect(await all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      await run(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }
  });

  it("serializes concurrent winners without double-decrementing or returning duplicate cleanup keys", async () => {
    const { id, t2 } = await seedCanonicalPost();
    const db = createDb(runtimeEnv.DB);
    const input = {
      openerId: id.opener,
      openerSeq: 3,
      forumChannelId: id.forum,
      childChannelId: id.child,
    };

    const results = await Promise.all([
      queries.communityForumPostDelete.deleteForumPost(db, input),
      queries.communityForumPostDelete.deleteForumPost(db, input),
    ]);

    expect(results.filter((result) => result.deleted)).toHaveLength(1);
    expect(results.filter((result) => result.mediaKeys.length > 0)).toHaveLength(1);
    expect(await first<{ message_count: number; last_message_at: string }>(
      "SELECT message_count, last_message_at FROM community_channel WHERE id = ?",
      id.forum,
    )).toEqual({ message_count: 2, last_message_at: t2 });
    expect(await first("SELECT id FROM community_channel WHERE id = ?", id.child)).toBeNull();
  });

  it("re-enumerates when a new human enters the destructive scope before batch commit", async () => {
    const { id, t2 } = await seedCanonicalPost();
    const lateReader = `fpd_late_${crypto.randomUUID().replaceAll("-", "")}`;
    createdUsers.push(lateReader);
    await run(
      "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Late', ?)",
      lateReader,
      `${lateReader}@example.com`,
      stamp4(lateReader),
    );

    const baseDb = createDb(runtimeEnv.DB);
    let injectBeforeFirstBatch = true;
    const racedDb = new Proxy(baseDb, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: unknown[]) => {
            if (injectBeforeFirstBatch) {
              injectBeforeFirstBatch = false;
              await run(
                `INSERT INTO community_read_state
                  (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq)
                 VALUES (?, ?, ?, '2026-08-23T01:02:00.000Z', ?, 3)`,
                `rs_late_${id.opener}`,
                lateReader,
                id.forum,
                id.opener,
              );
              expect(await first<{ isBot: number; lastReadMessageId: string }>(
                `SELECT u."isBot" AS isBot, rs.last_read_message_id AS lastReadMessageId
                 FROM user AS u
                 INNER JOIN community_read_state AS rs ON rs.user_id = u.id
                 WHERE u.id = ?`,
                lateReader,
              )).toEqual({ isBot: 0, lastReadMessageId: id.opener });
            }
            return target.batch(statements as never[]);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await queries.communityForumPostDelete.deleteForumPost(racedDb, {
      openerId: id.opener,
      openerSeq: 3,
      forumChannelId: id.forum,
      childChannelId: id.child,
    });

    expect(result.deleted).toBe(true);
    expect(new Set(result.readStateRevisions.map((revision) => revision.userId))).toEqual(
      new Set([id.owner, id.reader, lateReader]),
    );
    expect(result.readStateRevisions.find((revision) => revision.userId === lateReader)).toEqual({
      userId: lateReader, revision: 1,
    });
    await expect(queries.communityReadState.getAccountReadStateSnapshot(
      baseDb,
      lateReader,
    )).resolves.toEqual({
      revision: 1,
      readStates: [{
        channelId: id.forum,
        lastReadMessageId: id.siblingOpener,
        lastReadAt: t2,
        lastReadSeq: 2,
      }],
    });
  });

  it("returns the in-batch committed revision even when a later commit wins before result handling", async () => {
    const { id } = await seedCanonicalPost();
    const baseDb = createDb(runtimeEnv.DB);
    const laterMessage = `fpd_later_${crypto.randomUUID().replaceAll("-", "")}`;
    const laterTime = "2026-08-23T01:04:00.000Z";
    let interleaveAfterFirstBatch = true;
    const interleavedDb = new Proxy(baseDb, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: unknown[]) => {
            const committedResults = await target.batch(statements as never[]);
            if (interleaveAfterFirstBatch) {
              interleaveAfterFirstBatch = false;
              await runtimeEnv.DB.batch([
                runtimeEnv.DB.prepare(
                  `INSERT INTO community_message
                    (id, author_id, content, created_at, channel_id, seq)
                   VALUES (?, ?, 'later', ?, ?, 4)`,
                ).bind(laterMessage, id.owner, laterTime, id.forum),
                runtimeEnv.DB.prepare(
                  `UPDATE community_read_state
                   SET last_read_at = ?, last_read_message_id = ?, last_read_seq = 4
                   WHERE user_id = ? AND channel_id = ?`,
                ).bind(laterTime, laterMessage, id.owner, id.forum),
                runtimeEnv.DB.prepare(
                  `UPDATE community_read_state_revision
                   SET revision = revision + 1 WHERE user_id = ?`,
                ).bind(id.owner),
              ]);
            }
            return committedResults;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await queries.communityForumPostDelete.deleteForumPost(interleavedDb, {
      openerId: id.opener,
      openerSeq: 3,
      forumChannelId: id.forum,
      childChannelId: id.child,
    });

    expect(result.readStateRevisions.find((revision) => revision.userId === id.owner))
      .toEqual({ userId: id.owner, revision: 1 });
    expect(await first<{ revision: number }>(
      "SELECT revision FROM community_read_state_revision WHERE user_id = ?",
      id.owner,
    )).toEqual({ revision: 2 });
    expect(await first<{ last_read_message_id: string; last_read_seq: number }>(
      "SELECT last_read_message_id, last_read_seq FROM community_read_state WHERE user_id = ? AND channel_id = ?",
      id.owner,
      id.forum,
    )).toEqual({ last_read_message_id: laterMessage, last_read_seq: 4 });
  });
});
