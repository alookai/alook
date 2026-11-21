import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "../../src/db";
import {
  buildDecisionCardEmbed,
  DecisionCardInputSchema,
  type DecisionCardAssignee,
} from "../../src/community-decision-card";
import {
  dismissQuestionTodoWithRevision,
  listPendingQuestionMessages,
} from "../../src/db/queries/community/inbox";
import {
  getAccountAttentionProjection,
  MAX_ATTENTION_TODO_LIMIT,
} from "../../src/db/queries/community/attention";

const MIGRATION_0122 = readFileSync(
  new URL("../../../web/migrations/0122_community_question_todo.sql", import.meta.url),
  "utf8",
);

function makeCardEmbeds(assignees: DecisionCardAssignee[], summary = "Pick option") {
  const embed = buildDecisionCardEmbed(
    DecisionCardInputSchema.parse({
      summary,
      questions: [
        {
          id: "q1",
          question: "Continue?",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
      ],
    }),
    assignees,
  );
  return JSON.stringify([embed]);
}

function createSqliteAttentionDb(applyMigration = true) {
  const sqlite = new Sqlite(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      emailVerified INTEGER,
      isBot INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      avatarVersion INTEGER NOT NULL DEFAULT 0,
      avatarObjectKey TEXT,
      createdAt TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updatedAt TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      discriminator TEXT NOT NULL DEFAULT '0001',
      ownerUserId TEXT,
      deletedAt TEXT,
      lastRefreshContextAt TEXT
    );
    CREATE TABLE community_server (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      discriminator TEXT NOT NULL DEFAULT '0001',
      description TEXT DEFAULT '',
      icon TEXT,
      official INTEGER NOT NULL DEFAULT 0,
      owner_id TEXT NOT NULL REFERENCES user(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE community_category (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES community_server(id),
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      private INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE community_channel (
      id TEXT PRIMARY KEY,
      server_id TEXT REFERENCES community_server(id),
      category_id TEXT REFERENCES community_category(id),
      name TEXT,
      type TEXT NOT NULL DEFAULT 'text',
      topic TEXT DEFAULT '',
      position INTEGER DEFAULT 0,
      parent_channel_id TEXT REFERENCES community_channel(id),
      creator_id TEXT,
      message_count INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      parent_message_id TEXT,
      last_message_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE community_server_member (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES community_server(id),
      user_id TEXT NOT NULL REFERENCES user(id),
      role TEXT DEFAULT 'member',
      joined_at TEXT NOT NULL,
      UNIQUE(server_id, user_id)
    );
    CREATE TABLE community_channel_member (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES community_channel(id),
      user_id TEXT NOT NULL REFERENCES user(id),
      relation TEXT NOT NULL DEFAULT 'access',
      source TEXT NOT NULL DEFAULT 'added',
      added_by TEXT,
      added_at TEXT NOT NULL,
      UNIQUE(channel_id, user_id, relation)
    );
    CREATE TABLE community_message (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL REFERENCES user(id),
      content TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'default',
      mention_type TEXT,
      reply_to_id TEXT,
      embeds TEXT,
      created_at TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES community_channel(id),
      seq INTEGER NOT NULL,
      friendship_id TEXT,
      client_nonce TEXT
    );
    CREATE INDEX idx_community_message_channel_reply_author
      ON community_message (channel_id, reply_to_id, author_id)
      WHERE reply_to_id IS NOT NULL;
    CREATE TABLE community_read_state (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user(id),
      channel_id TEXT NOT NULL REFERENCES community_channel(id),
      last_read_at TEXT NOT NULL,
      last_read_message_id TEXT,
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, channel_id)
    );
    CREATE TABLE community_read_state_revision (
      user_id TEXT PRIMARY KEY REFERENCES user(id),
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE community_mention (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES community_message(id),
      user_id TEXT NOT NULL REFERENCES user(id),
      kind TEXT NOT NULL DEFAULT 'mention',
      read INTEGER DEFAULT 0
    );
    CREATE TABLE community_friendship (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL REFERENCES user(id),
      addressee_id TEXT NOT NULL REFERENCES user(id),
      status TEXT NOT NULL,
      needs_owner_approval INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE community_user_profile (
      user_id TEXT PRIMARY KEY REFERENCES user(id),
      about_me TEXT,
      banner_color TEXT,
      status_emoji TEXT,
      status_text TEXT DEFAULT ''
    );
    CREATE TABLE community_notification_setting (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user(id),
      server_id TEXT REFERENCES community_server(id),
      channel_id TEXT REFERENCES community_channel(id),
      level TEXT NOT NULL DEFAULT 'all'
    );
  `);

  if (applyMigration) {
    sqlite.exec(MIGRATION_0122);
  }

  const orm = drizzle(sqlite);
  const db = orm as unknown as Database;
  (db as any).batch = async (statements: any[]) =>
    sqlite.transaction(() =>
      statements.map((statement) => {
        const query = statement.toSQL();
        return sqlite.prepare(query.sql).reader ? statement.all() : statement.run();
      }),
    )();

  return { sqlite, db };
}

describe("0122_community_question_todo migration and bounded per-user Todo queries", () => {
  it("backfills assigned historical question cards safely and ignores invalid/self/unassigned rows", () => {
    const { sqlite } = createSqliteAttentionDb(false);
    sqlite.exec(`
      INSERT INTO user (id, name, discriminator, isBot) VALUES
        ('viewer', 'Gus', '1813', 0),
        ('other', 'Other', '0002', 0),
        ('bot', 'Evan', '6524', 1);
      INSERT INTO community_server (id, name, discriminator, owner_id, created_at)
        VALUES ('s1', 'Alook', '5620', 'viewer', '2026-01-01T00:00:00.000Z');
      INSERT INTO community_channel (id, server_id, name, type, created_at)
        VALUES ('c1', 's1', 'general', 'text', '2026-01-01T00:00:00.000Z');
    `);

    const insertMsg = sqlite.prepare(`
      INSERT INTO community_message (id, author_id, content, type, embeds, channel_id, seq, created_at)
      VALUES (?, ?, ?, ?, ?, 'c1', ?, ?)
    `);
    insertMsg.run("q_mine", "bot", "Mine", "question", makeCardEmbeds([{ userId: "viewer", handle: "Gus#1813" }]), 1, "2026-01-01T00:01:00.000Z");
    insertMsg.run("q_other", "bot", "Other", "question", makeCardEmbeds([{ userId: "other", handle: "Other#0002" }]), 2, "2026-01-01T00:02:00.000Z");
    insertMsg.run("q_open", "bot", "Open poll", "question", makeCardEmbeds([]), 3, "2026-01-01T00:03:00.000Z");
    insertMsg.run("q_self", "viewer", "Self asked", "question", makeCardEmbeds([{ userId: "viewer", handle: "Gus#1813" }]), 4, "2026-01-01T00:04:00.000Z");
    insertMsg.run("q_malformed", "bot", "Broken", "question", "{not-json", 5, "2026-01-01T00:05:00.000Z");
    insertMsg.run("q_ghost", "bot", "Ghost assignee", "question", makeCardEmbeds([{ userId: "deleted_user", handle: "Ghost#9999" }]), 6, "2026-01-01T00:06:00.000Z");
    insertMsg.run("chat_1", "bot", "Regular chat", "default", null, 7, "2026-01-01T00:07:00.000Z");

    // Plain string mixed with a valid decision card in `embeds`.
    const validCardObj = JSON.parse(makeCardEmbeds([{ userId: "viewer", handle: "Gus#1813" }]))[0];
    insertMsg.run("q_mixed_embeds", "bot", "Mixed embeds", "question", JSON.stringify(["plain-string", validCardObj]), 8, "2026-01-01T00:08:00.000Z");

    // Plain string mixed with a valid assignee object in `assignees`.
    const mixedAssigneesCard = {
      ...validCardObj,
      assignees: ["plain-assignee-string", { userId: "viewer", handle: "Gus#1813" }],
    };
    insertMsg.run("q_mixed_assignees", "bot", "Mixed assignees", "question", JSON.stringify([mixedAssigneesCard]), 9, "2026-01-01T00:09:00.000Z");

    sqlite.exec(MIGRATION_0122);

    const rows = sqlite
      .prepare("SELECT user_id, message_id, channel_id, dismissed_at FROM community_question_todo ORDER BY message_id")
      .all();
    expect(rows).toEqual([
      { user_id: "viewer", message_id: "q_mine", channel_id: "c1", dismissed_at: null },
      { user_id: "viewer", message_id: "q_mixed_assignees", channel_id: "c1", dismissed_at: null },
      { user_id: "viewer", message_id: "q_mixed_embeds", channel_id: "c1", dismissed_at: null },
      { user_id: "other", message_id: "q_other", channel_id: "c1", dismissed_at: null },
    ]);
  });

  it("reads only viewer's own pending Todo from idx_community_question_todo_user_active even behind 150 other-user question cards", async () => {
    const { sqlite, db } = createSqliteAttentionDb(true);
    sqlite.exec(`
      INSERT INTO user (id, name, discriminator, isBot) VALUES
        ('viewer', 'Gus', '1813', 0),
        ('other', 'Other', '0002', 0),
        ('bot', 'Evan', '6524', 1);
      INSERT INTO community_server (id, name, discriminator, owner_id, created_at)
        VALUES ('s1', 'Alook', '5620', 'viewer', '2026-01-01T00:00:00.000Z');
      INSERT INTO community_server_member (id, server_id, user_id, role, joined_at)
        VALUES ('m1', 's1', 'viewer', 'owner', '2026-01-01T00:00:00.000Z');
      INSERT INTO community_channel (id, server_id, name, type, created_at)
        VALUES ('c1', 's1', 'general', 'text', '2026-01-01T00:00:00.000Z');
    `);

    const insertMsg = sqlite.prepare(`
      INSERT INTO community_message (id, author_id, content, type, embeds, channel_id, seq, created_at)
      VALUES (?, 'bot', ?, 'question', ?, 'c1', ?, ?)
    `);
    const insertTodo = sqlite.prepare(`
      INSERT INTO community_question_todo (user_id, message_id, channel_id, created_at, dismissed_at)
      VALUES (?, ?, 'c1', ?, NULL)
    `);

    // One older question assigned to viewer.
    insertMsg.run("q_viewer_old", "Old viewer ask", makeCardEmbeds([{ userId: "viewer", handle: "Gus#1813" }], "Old viewer ask"), 1, "2026-01-01T00:00:01.000Z");
    insertTodo.run("viewer", "q_viewer_old", "2026-01-01T00:00:01.000Z");

    // 150 newer questions assigned to another user in the same channel.
    const otherEmbeds = makeCardEmbeds([{ userId: "other", handle: "Other#0002" }], "Other user ask");
    for (let i = 1; i <= 150; i += 1) {
      const ts = `2026-01-02T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`;
      insertMsg.run(`q_other_${i}`, `Other ask ${i}`, otherEmbeds, i + 1, ts);
      insertTodo.run("other", `q_other_${i}`, ts);
    }

    // Channel is fully read by viewer.
    sqlite.prepare(`
      INSERT INTO community_read_state (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq)
      VALUES ('rs1', 'viewer', 'c1', '2026-01-03T00:00:00.000Z', 'q_other_150', 151)
    `).run();

    // Capture the actual production SQL and bound parameters emitted by
    // `listPendingQuestionMessages` and run `EXPLAIN QUERY PLAN` directly on it.
    const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];
    const origPrepare = sqlite.prepare.bind(sqlite);
    const prepareSpy = ((sqlText: string) => {
      const stmt = origPrepare(sqlText);
      const origAll = stmt.all.bind(stmt);
      stmt.all = ((...params: unknown[]) => {
        if (sqlText.includes("community_question_todo") && !sqlText.startsWith("EXPLAIN")) {
          capturedQueries.push({ sql: sqlText, params });
        }
        return origAll(...params);
      }) as typeof stmt.all;
      return stmt;
    }) as typeof sqlite.prepare;
    sqlite.prepare = prepareSpy;
    const pending = await listPendingQuestionMessages(db, "viewer", ["c1"], [], { limit: 10 });
    sqlite.prepare = origPrepare;

    expect(pending.map((row) => row.id)).toEqual(["q_viewer_old"]);
    expect(capturedQueries).toHaveLength(1);
    const prodQuery = capturedQueries[0]!;
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${prodQuery.sql}`)
      .all(...prodQuery.params) as Array<{ detail: string }>;
    const planText = plan.map((row) => row.detail).join("\n");
    expect(planText).toContain("idx_community_question_todo_user_active");
    expect(planText).toContain("idx_community_message_channel_reply_author");
    expect(planText).not.toContain("TEMP B-TREE");

    const projection = await getAccountAttentionProjection(db, "viewer", 10);
    expect(projection.truncated).toBe(false);
    expect(projection.todosTruncated).toBe(false);
    expect(projection.items.filter((item) => item.kind === "question").map((item) => item.messageId)).toEqual(["q_viewer_old"]);
    expect(projection.included.messages.map((message) => message.id)).toEqual(["q_viewer_old"]);

    // Answering hides the Todo; deleting the reply restores it (single source of truth).
    sqlite.prepare(`
      INSERT INTO community_message (id, author_id, content, type, reply_to_id, channel_id, seq, created_at)
      VALUES ('reply_1', 'viewer', 'Yes', 'default', 'q_viewer_old', 'c1', 152, '2026-01-04T00:00:00.000Z')
    `).run();
    expect(await listPendingQuestionMessages(db, "viewer", ["c1"], [], { limit: 10 })).toEqual([]);

    sqlite.prepare("DELETE FROM community_message WHERE id = 'reply_1'").run();
    expect((await listPendingQuestionMessages(db, "viewer", ["c1"], [], { limit: 10 })).map((r) => r.id)).toEqual(["q_viewer_old"]);

    // Dismiss hides the Todo and is idempotent on retry.
    const firstDismiss = await dismissQuestionTodoWithRevision(db, "viewer", "q_viewer_old");
    expect(firstDismiss.changed).toBe(true);
    expect(firstDismiss.revision).toBe(1);
    expect(await listPendingQuestionMessages(db, "viewer", ["c1"], [], { limit: 10 })).toEqual([]);

    const secondDismiss = await dismissQuestionTodoWithRevision(db, "viewer", "q_viewer_old");
    expect(secondDismiss.changed).toBe(false);
    expect(secondDismiss.revision).toBe(1);
  });

  it("bounds Todo items and channel hydration to requested limit and MAX_ATTENTION_TODO_LIMIT", async () => {
    const { sqlite, db } = createSqliteAttentionDb(true);
    sqlite.exec(`
      INSERT INTO user (id, name, discriminator, isBot) VALUES
        ('viewer', 'Gus', '1813', 0),
        ('bot', 'Evan', '6524', 1);
      INSERT INTO community_server (id, name, discriminator, owner_id, created_at)
        VALUES ('s1', 'Alook', '5620', 'viewer', '2026-01-01T00:00:00.000Z');
      INSERT INTO community_server_member (id, server_id, user_id, role, joined_at)
        VALUES ('m1', 's1', 'viewer', 'owner', '2026-01-01T00:00:00.000Z');
    `);

    const insertChannel = sqlite.prepare(`
      INSERT INTO community_channel (id, server_id, name, type, created_at)
      VALUES (?, 's1', ?, 'text', '2026-01-01T00:00:00.000Z')
    `);
    const insertMsg = sqlite.prepare(`
      INSERT INTO community_message (id, author_id, content, type, embeds, channel_id, seq, created_at)
      VALUES (?, 'bot', ?, 'question', ?, ?, 1, ?)
    `);
    const insertTodo = sqlite.prepare(`
      INSERT INTO community_question_todo (user_id, message_id, channel_id, created_at, dismissed_at)
      VALUES ('viewer', ?, ?, ?, NULL)
    `);
    const insertRead = sqlite.prepare(`
      INSERT INTO community_read_state (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq)
      VALUES (?, 'viewer', ?, '2026-01-10T00:00:00.000Z', ?, 1)
    `);

    const embeds = makeCardEmbeds([{ userId: "viewer", handle: "Gus#1813" }], "Need review");
    for (let i = 1; i <= 60; i += 1) {
      const idx = String(i).padStart(2, "0");
      const channelId = `ch_${idx}`;
      const messageId = `q_${idx}`;
      const ts = `2026-01-02T00:${idx}:00.000Z`;
      insertChannel.run(channelId, `chan-${idx}`);
      insertMsg.run(messageId, `Question ${idx}`, embeds, channelId, ts);
      insertTodo.run(messageId, channelId, ts);
      insertRead.run(`rs_${idx}`, channelId, messageId);
    }

    // Explicit small limit caps both Todo items and hydrated channels/messages.
    const small = await getAccountAttentionProjection(db, "viewer", 10);
    expect(small.truncated).toBe(false);
    expect(small.todosTruncated).toBe(true);
    expect(small.items.filter((item) => item.kind === "question")).toHaveLength(10);
    expect(small.items[0]).toMatchObject({ kind: "question", messageId: "q_60" });
    expect(small.included.messages).toHaveLength(10);
    expect(small.included.channels).toHaveLength(10);

    // Default limit=100 still caps Todo items and hydration at MAX_ATTENTION_TODO_LIMIT (50).
    const capped = await getAccountAttentionProjection(db, "viewer", 100);
    expect(capped.truncated).toBe(false);
    expect(capped.todosTruncated).toBe(true);
    expect(capped.items.filter((item) => item.kind === "question")).toHaveLength(MAX_ATTENTION_TODO_LIMIT);
    expect(capped.included.messages).toHaveLength(MAX_ATTENTION_TODO_LIMIT);
    expect(capped.included.channels).toHaveLength(MAX_ATTENTION_TODO_LIMIT);
  });

  it("hydrates a read DM with a pending Todo question via listReadableDmSummariesByChannelIds", async () => {
    const { sqlite, db } = createSqliteAttentionDb(true);
    sqlite.exec(`
      INSERT INTO user (id, name, discriminator, isBot) VALUES
        ('viewer', 'Gus', '1813', 0),
        ('peer', 'Cecilia', '7971', 1);
      INSERT INTO community_friendship (id, requester_id, addressee_id, status, needs_owner_approval)
        VALUES ('f1', 'viewer', 'peer', 'accepted', 0);
      INSERT INTO community_channel (id, server_id, name, type, last_message_at, created_at)
        VALUES ('dm_1', NULL, NULL, 'dm', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES
        ('cm1', 'dm_1', 'viewer', 'access', 'added', '2026-01-01T00:00:00.000Z'),
        ('cm2', 'dm_1', 'peer', 'access', 'added', '2026-01-01T00:00:00.000Z');
    `);
    const dmEmbeds = makeCardEmbeds([{ userId: "viewer", handle: "Gus#1813" }], "DM review");
    sqlite.prepare(`
      INSERT INTO community_message (id, author_id, content, type, embeds, channel_id, seq, created_at)
      VALUES ('q_dm_read', 'peer', 'DM review', 'question', ?, 'dm_1', 1, '2026-01-02T00:00:00.000Z')
    `).run(dmEmbeds);
    sqlite.prepare(`
      INSERT INTO community_question_todo (user_id, message_id, channel_id, created_at, dismissed_at)
      VALUES ('viewer', 'q_dm_read', 'dm_1', '2026-01-02T00:00:00.000Z', NULL)
    `).run();
    // Mark DM as fully read so listEligibleUnreadDms returns [] and attention hydrates dm_1 via listReadableDmSummariesByChannelIds.
    sqlite.prepare(`
      INSERT INTO community_read_state (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq)
      VALUES ('rs_dm1', 'viewer', 'dm_1', '2026-01-02T00:01:00.000Z', 'q_dm_read', 1)
    `).run();

    const projection = await getAccountAttentionProjection(db, "viewer", 10);
    expect(projection.scopes).toEqual([]);
    expect(projection.todosTruncated).toBe(false);
    expect(projection.items.filter((item) => item.kind === "question").map((item) => item.messageId)).toEqual(["q_dm_read"]);
    expect(projection.included.dms).toEqual([
      expect.objectContaining({
        id: "dm_1",
        userId: "peer",
        name: "Cecilia",
        lastUnreadSeq: 0,
      }),
    ]);
  });
});
