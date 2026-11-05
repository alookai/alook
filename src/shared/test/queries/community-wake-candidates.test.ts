import { describe, it, expect, vi } from "vitest";
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "../../src/db";
import { findWakeCandidates } from "../../src/db/queries/community/bot";

// Terminal-where mock — the module chains
// select().from().innerJoin().leftJoin().where(), and `.where()` is the
// terminal call that resolves to rows. `findWakeCandidates` issues exactly
// one `db.select(...)` call — the main candidate query. `sequences` supplies
// one result array per call, in order; a call beyond the supplied
// sequences resolves to []. We don't re-verify the WHERE predicate itself
// here (that's SQL, exercised in e2e/integration); this covers the
// post-fetch filter and row shape, which is the part `enqueueBotWakes`
// actually depends on.
function createSelectMock(...sequences: unknown[][]) {
  let call = 0;
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(sequences[call++] ?? []));
  return chain;
}

describe("findWakeCandidates", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    botUserId: "bot1",
    name: "zoe",
    discriminator: "0001",
    instruction: "Own triage",
    machineId: "m1",
    runtime: "claude",
    lastReadSeq: 0,
    ...overrides,
  });
  const candidate = {
    botUserId: "bot1",
    name: "zoe",
    discriminator: "0001",
    instruction: "Own triage",
    machineId: "m1",
    runtime: "claude",
  };

  it("returns [] and never queries when recipients is empty", async () => {
    const db = createSelectMock([{ botUserId: "never", name: "x", machineId: "m", runtime: "claude", lastReadSeq: 0 }]);
    const result = await findWakeCandidates(db as never, {
      recipients: [],
      channelId: "c1",
      newSeq: 5,
    });
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("excludes candidates already caught up (lastReadSeq >= newSeq)", async () => {
    const db = createSelectMock([
      row({ lastReadSeq: 3 }),
      row({ botUserId: "bot2", name: "kai", discriminator: "0002", machineId: "m2", runtime: "codex", lastReadSeq: 10 }),
      row({ botUserId: "bot3", name: "equal", discriminator: "0003", machineId: "m3", lastReadSeq: 7 }),
    ]);
    const result = await findWakeCandidates(db as never, {
      recipients: ["bot1", "bot2", "bot3"],
      channelId: "c1",
      newSeq: 7,
    });
    expect(result).toEqual([candidate]);
  });

  it("treats a NULL lastReadSeq (never read) as behind — included", async () => {
    const db = createSelectMock([
      row({ lastReadSeq: null }),
    ]);
    const result = await findWakeCandidates(db as never, {
      recipients: ["bot1"],
      channelId: "c1",
      newSeq: 1,
    });
    expect(result).toEqual([candidate]);
  });

  it("isolates wake cursors with canonical channelId in a DM", async () => {
    const sqlite = new Sqlite(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE user (
          id TEXT PRIMARY KEY, name TEXT, discriminator TEXT NOT NULL,
          isBot INTEGER NOT NULL, deletedAt TEXT
        );
        CREATE TABLE community_bot_binding (
          user_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, runtime TEXT NOT NULL,
          instruction TEXT NOT NULL, is_active INTEGER NOT NULL
        );
        CREATE TABLE community_channel (id TEXT PRIMARY KEY, type TEXT NOT NULL);
        CREATE TABLE community_message (
          id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE community_read_state (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
          last_read_seq INTEGER NOT NULL, last_read_message_id TEXT NOT NULL,
          last_read_at TEXT NOT NULL, UNIQUE(user_id, channel_id)
        );
        INSERT INTO user VALUES ('bot1', 'zoe', '0001', 1, NULL), ('bot_neighbor', 'other', '0002', 1, NULL);
        INSERT INTO community_bot_binding VALUES
          ('bot1', 'm1', 'claude', 'Own triage', 1),
          ('bot_neighbor', 'm2', 'codex', 'Other triage', 1);
        INSERT INTO community_channel VALUES ('dm1', 'dm'), ('c1', 'text');
        INSERT INTO community_message VALUES
          ('dm-7', 'dm1', 7, '2026-01-01T00:00:07.000Z'),
          ('c-1', 'c1', 1, '2026-01-01T00:00:01.000Z'),
          ('c-7', 'c1', 7, '2026-01-01T00:00:07.000Z');
        INSERT INTO community_read_state VALUES
          ('rs-dm', 'bot1', 'dm1', 7, 'dm-7', '2026-01-01T00:00:07.000Z'),
          ('rs-c', 'bot1', 'c1', 1, 'c-1', '2026-01-01T00:00:01.000Z');
      `);
      const db = drizzle(sqlite) as unknown as Database;
      expect(await findWakeCandidates(db, { recipients: ["bot1"], channelId: "dm1", newSeq: 7 }))
        .toEqual([]);
      expect(await findWakeCandidates(db, { recipients: ["bot1"], channelId: "c1", newSeq: 7 }))
        .toEqual([candidate]);
    } finally {
      sqlite.close();
    }
  });

  it("issues exactly one db.select call — no notification-setting/mention lookups", async () => {
    const db = createSelectMock([
      row(),
    ]);
    const result = await findWakeCandidates(db as never, {
      recipients: ["bot1"],
      channelId: "c1",
      newSeq: 1,
    });
    expect(result).toEqual([candidate]);
    expect((db.select as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
