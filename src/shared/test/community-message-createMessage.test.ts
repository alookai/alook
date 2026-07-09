import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import { queries } from "../src/index";
import type { Database } from "../src/index";

/**
 * Unit tests for `createMessage` batch composition.
 *
 * `createMessage` was refactored from 4 sequential awaits to:
 *   (1) claimNextSeq — separate await
 *   (2) db.batch([insertMsg.returning(), scopeUpdate]) — atomic pair
 *   (3) author read-state upsert — separate await (needs msg.id from step 2)
 *
 * These tests mock the Database builder chain and assert the batch's
 * contents, without needing a real D1 backend.
 */

type BuilderTag =
  | { kind: "insert-msg" }
  | { kind: "update-channel" }
  | { kind: "update-dm" }
  | { kind: "insert-readstate"; values: Record<string, unknown> };

interface MockDb {
  batchCalls: Array<BuilderTag[]>;
  awaitedStatements: BuilderTag[];
  seqReturned: number;
}

function makeMockDb(seq: number): { db: Database; state: MockDb } {
  const state: MockDb = { batchCalls: [], awaitedStatements: [], seqReturned: seq };

  // Every builder is thenable so `await` on it resolves; also tagged so
  // the batch inspector can identify it after composition.
  const makeReturningBuilder = (tag: BuilderTag, resolveValue: unknown) => {
    const b: any = { __tag: tag };
    b.values = () => b;
    b.set = () => b;
    b.where = () => b;
    b.onConflictDoUpdate = () => b;
    b.returning = () => b;
    // Awaiting the builder outside a batch resolves like a real query.
    b.then = (resolve: (v: unknown) => void) => {
      state.awaitedStatements.push(tag);
      resolve(resolveValue);
    };
    return b;
  };

  const db: any = {
    insert: (table: any) => {
      const name = getTableName(table);
      if (name.includes("read_state")) {
        // Read-state upsert captures its `values(...)` payload for assertions.
        const b: any = { __tag: { kind: "insert-readstate", values: {} } };
        b.values = (v: Record<string, unknown>) => {
          b.__tag.values = v;
          return b;
        };
        b.onConflictDoUpdate = () => b;
        b.then = (resolve: (v: unknown) => void) => {
          state.awaitedStatements.push(b.__tag);
          resolve(undefined);
        };
        return b;
      }
      // Assume message insert — resolves to a row array carrying the seq we
      // stored so callers can pick out msg.id/seq.
      const row = { id: "msg_test", seq: state.seqReturned, createdAt: "2026-01-01T00:00:00.000Z" };
      return makeReturningBuilder({ kind: "insert-msg" }, [row]);
    },
    update: (table: any) => {
      const name = getTableName(table);
      const tag: BuilderTag = name.includes("dm_conversation")
        ? { kind: "update-dm" }
        : { kind: "update-channel" };
      return makeReturningBuilder(tag, undefined);
    },
    batch: (stmts: any[]) => {
      const tags = stmts.map((s) => s.__tag as BuilderTag);
      state.batchCalls.push(tags);
      // Resolve like a real batch: first stmt's `.returning()` is the msg
      // rows array, others resolve to `undefined`.
      return Promise.resolve(
        tags.map((t) =>
          t.kind === "insert-msg"
            ? [{ id: "msg_test", seq: state.seqReturned, createdAt: "2026-01-01T00:00:00.000Z" }]
            : undefined
        )
      );
    },
  };

  // Override insert so the message-seq table returns the shape claimNextSeq expects.
  const originalInsert = db.insert.bind(db);
  db.insert = (table: any) => {
    const name = getTableName(table);
    if (name.includes("message_seq")) {
      const b: any = { __tag: { kind: "insert-seq" } };
      b.values = () => b;
      b.onConflictDoUpdate = () => b;
      b.returning = () => Promise.resolve([{ nextSeq: state.seqReturned }]);
      return b;
    }
    return originalInsert(table);
  };

  return { db: db as Database, state };
}

describe("createMessage — batch composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("channel send: batches (insert msg, update channel) and separately upserts author read-state with lastReadSeq", async () => {
    const { db, state } = makeMockDb(42);
    const msg = await queries.communityMessage.createMessage(db, {
      authorId: "user_1",
      content: "hello",
      channelId: "chan_1",
    });

    expect(state.batchCalls).toHaveLength(1);
    const batchTags = state.batchCalls[0]!.map((t) => t.kind);
    expect(batchTags).toEqual(["insert-msg", "update-channel"]);

    // Author read-state runs after the batch as its own await, and must
    // carry `lastReadSeq: seq` (design §4 — bot-as-author wake filter reads it).
    const readState = state.awaitedStatements.find((s) => s.kind === "insert-readstate");
    expect(readState).toBeDefined();
    const values = (readState as { kind: "insert-readstate"; values: Record<string, unknown> })
      .values;
    expect(values.lastReadSeq).toBe(42);
    expect(values.lastReadMessageId).toBe("msg_test");
    expect(values.channelId).toBe("chan_1");
    expect(values.dmConversationId).toBeNull();

    expect(msg.id).toBe("msg_test");
    expect(msg.seq).toBe(42);
  });

  it("DM send: batches (insert msg, update dmConversation) and separately upserts author read-state with lastReadSeq", async () => {
    const { db, state } = makeMockDb(7);
    const msg = await queries.communityMessage.createMessage(db, {
      authorId: "user_1",
      content: "hi",
      dmConversationId: "dm_1",
    });

    expect(state.batchCalls).toHaveLength(1);
    const batchTags = state.batchCalls[0]!.map((t) => t.kind);
    expect(batchTags).toEqual(["insert-msg", "update-dm"]);

    const readState = state.awaitedStatements.find((s) => s.kind === "insert-readstate");
    expect(readState).toBeDefined();
    const values = (readState as { kind: "insert-readstate"; values: Record<string, unknown> })
      .values;
    expect(values.lastReadSeq).toBe(7);
    expect(values.lastReadMessageId).toBe("msg_test");
    expect(values.channelId).toBeNull();
    expect(values.dmConversationId).toBe("dm_1");

    expect(msg.id).toBe("msg_test");
    expect(msg.seq).toBe(7);
  });
});
