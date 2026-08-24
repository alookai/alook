import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import { queries } from "../src/index";
import type { Database } from "../src/index";

/**
 * Unit tests for `createMessage` batch composition.
 *
 * `createMessage` was refactored from 4 sequential awaits to:
 *   (1) claimNextSeq — separate await
 *   (2) db.batch([insertMsg.returning(), scopeUpdate, authorWatermark]) —
 *       atomic author-send aggregate write. The message id is pre-minted so
 *       the watermark no longer needs a post-batch await.
 *
 * These tests mock the Database builder chain and assert the batch's
 * contents, without needing a real D1 backend.
 */

type BuilderTag =
  | { kind: "insert-msg" }
  | { kind: "update-channel" }
  | { kind: "update-dm" }
  | { kind: "insert-revision" }
  | { kind: "select-readstates" }
  | { kind: "insert-readstate"; values: Record<string, unknown> };

interface MockDb {
  batchCalls: Array<BuilderTag[]>;
  awaitedStatements: BuilderTag[];
  seqReturned: number;
  messageId?: string;
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
      if (name.includes("read_state_revision")) {
        return makeReturningBuilder({ kind: "insert-revision" }, [{ revision: 3 }]);
      }
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
      const b = makeReturningBuilder({ kind: "insert-msg" }, []);
      b.values = (values: { id: string }) => {
        state.messageId = values.id;
        return b;
      };
      return b;
    },
    update: (table: any) => {
      const name = getTableName(table);
      const tag: BuilderTag = name.includes("dm_conversation")
        ? { kind: "update-dm" }
        : { kind: "update-channel" };
      return makeReturningBuilder(tag, undefined);
    },
    select: () => {
      const row = {
        channelId: "chan_1",
        lastReadMessageId: state.messageId!,
        lastReadAt: "2026-01-01T00:00:00.000Z",
        lastReadSeq: state.seqReturned,
      };
      const b = makeReturningBuilder({ kind: "select-readstates" }, [row]);
      b.from = () => b;
      return b;
    },
    batch: (stmts: any[]) => {
      const tags = stmts.map((s) => s.__tag as BuilderTag);
      state.batchCalls.push(tags);
      // Resolve like a real batch: first stmt's `.returning()` is the msg
      // rows array, others resolve to `undefined`.
      return Promise.resolve(
        tags.map((t) =>
          t.kind === "insert-msg"
            ? [{ id: state.messageId!, seq: state.seqReturned, createdAt: "2026-01-01T00:00:00.000Z" }]
            : t.kind === "insert-revision"
              ? [{ revision: 3 }]
              : t.kind === "select-readstates"
                ? [{
                    channelId: "chan_1",
                    lastReadMessageId: state.messageId!,
                    lastReadAt: "2026-01-01T00:00:00.000Z",
                    lastReadSeq: state.seqReturned,
                  }]
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

  it("channel send atomically batches message, channel, and author read-state watermark", async () => {
    const { db, state } = makeMockDb(42);
    const msg = await queries.communityMessage.createMessage(db, {
      authorId: "user_1",
      content: "hello",
      channelId: "chan_1",
    });

    expect(state.batchCalls).toHaveLength(1);
    const batchTags = state.batchCalls[0]!.map((t) => t.kind);
    expect(batchTags).toEqual(["insert-msg", "update-channel", "insert-readstate"]);

    const readState = state.batchCalls[0]!.find((s) => s.kind === "insert-readstate");
    expect(readState).toBeDefined();
    const values = (readState as { kind: "insert-readstate"; values: Record<string, unknown> })
      .values;
    expect(values.lastReadSeq).toBe(42);
    expect(values.lastReadMessageId).toBe(msg.id);
    expect(values.channelId).toBe("chan_1");

    expect(msg.id).toBe(state.messageId);
    expect(msg.seq).toBe(42);
  });

  it("DM send atomically batches message, channel, and author read-state watermark", async () => {
    const { db, state } = makeMockDb(7);
    const msg = await queries.communityMessage.createMessage(db, {
      authorId: "user_1",
      content: "hi",
      channelId: "dm_chan_1",
    });

    expect(state.batchCalls).toHaveLength(1);
    const batchTags = state.batchCalls[0]!.map((t) => t.kind);
    // DMs are channels now — the scope bump always targets communityChannel.
    expect(batchTags).toEqual(["insert-msg", "update-channel", "insert-readstate"]);

    const readState = state.batchCalls[0]!.find((s) => s.kind === "insert-readstate");
    expect(readState).toBeDefined();
    const values = (readState as { kind: "insert-readstate"; values: Record<string, unknown> })
      .values;
    expect(values.lastReadSeq).toBe(7);
    expect(values.lastReadMessageId).toBe(msg.id);
    expect(values.channelId).toBe("dm_chan_1");

    expect(msg.id).toBe(state.messageId);
    expect(msg.seq).toBe(7);
  });

  it("human send atomically appends a revision without materializing account rows", async () => {
    const { db, state } = makeMockDb(9);
    const msg = await queries.communityMessage.createMessage(db, {
      authorId: "human_1",
      authorKind: "human",
      content: "hello from another device",
      channelId: "chan_1",
    });

    expect(state.batchCalls[0]!.map((statement) => statement.kind)).toEqual([
      "insert-msg",
      "update-channel",
      "insert-readstate",
      "insert-revision",
    ]);
    expect(msg.readStateRevision).toBe(3);
  });
});
