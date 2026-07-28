import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { queries } from "../src/index";
import type { Database } from "../src/index";

/**
 * Tests for the cascading `hardDeleteMessage`. It:
 *   1. SELECTs the message row (channelId/dmConversationId/authorId/seq/createdAt).
 *   2. SELECTs the prior message in scope (id, seq, createdAt) for the read-state revert.
 *   3. Runs one `db.batch([delete-msg, update-scope, update-or-delete-readstate])`.
 * The batch composition varies by whether the target is a channel/DM and whether
 * a prior message exists.
 */

type SelectShape = "message" | "prior";
type Tag =
  | { kind: "delete-msg" }
  | { kind: "update-channel"; setValues?: Record<string, unknown> }
  | { kind: "update-dm"; setValues?: Record<string, unknown> }
  | { kind: "update-readstate"; setValues?: Record<string, unknown> }
  | { kind: "delete-readstate" };

interface MockState {
  batchCalls: Tag[][];
  selectQueue: Array<{ shape: SelectShape; rows: unknown[] }>;
}

function makeDb(state: MockState): Database {
  const mkBuilder = (tag: Tag) => {
    const b: any = { __tag: tag };
    b.set = (values: Record<string, unknown>) => {
      // Capture the set(...) payload so tests can assert on messageCount /
      // lastMessageAt / lastReadMessageId values, not just batch shape.
      (tag as { setValues?: Record<string, unknown> }).setValues = values;
      return b;
    };
    b.where = () => b;
    b.limit = () => b;
    b.orderBy = () => b;
    return b;
  };

  const db: any = {
    select: () => {
      const b: any = {};
      b.from = () => b;
      b.where = () => b;
      b.orderBy = () => b;
      b.limit = () => {
        const next = state.selectQueue.shift();
        if (!next) throw new Error("unexpected select — selectQueue empty");
        return Promise.resolve(next.rows);
      };
      return b;
    },
    delete: (table: any) => {
      const name = getTableName(table);
      const tag: Tag = name.includes("read_state")
        ? { kind: "delete-readstate" }
        : { kind: "delete-msg" };
      return mkBuilder(tag);
    },
    update: (table: any) => {
      const name = getTableName(table);
      const tag: Tag = name.includes("read_state")
        ? { kind: "update-readstate" }
        : name.includes("dm_conversation")
        ? { kind: "update-dm" }
        : { kind: "update-channel" };
      return mkBuilder(tag);
    },
    batch: (stmts: any[]) => {
      state.batchCalls.push(stmts.map((s) => s.__tag as Tag));
      return Promise.resolve(stmts.map(() => undefined));
    },
  };
  return db as Database;
}

describe("hardDeleteMessage — cascading rollback", () => {
  it("channel + prior message exists → batch(delete-msg, update-channel, update-readstate)", async () => {
    const state: MockState = {
      batchCalls: [],
      selectQueue: [
        {
          shape: "message",
          rows: [
            {
              id: "msg_1",
              channelId: "chan_1",
              dmConversationId: null,
              authorId: "user_1",
              seq: 5,
              createdAt: "2026-01-01T00:00:05Z",
            },
          ],
        },
        {
          shape: "prior",
          rows: [{ id: "msg_0", seq: 4, createdAt: "2026-01-01T00:00:04Z" }],
        },
      ],
    };
    await queries.communityMessage.hardDeleteMessage(makeDb(state), "msg_1");
    expect(state.batchCalls).toHaveLength(1);
    const [del, upChan, upRs] = state.batchCalls[0]!;
    expect(del.kind).toBe("delete-msg");
    expect(upChan.kind).toBe("update-channel");
    expect(upRs.kind).toBe("update-readstate");
    // Regression guard for the plan's "CRITICAL" rule: messageCount must be a
    // SQL fragment / decrement expression, NOT a JS literal like `oldCount - 1`
    // (a concurrent inbound insert between the SELECT and this UPDATE would
    // otherwise get clobbered). Same story for lastMessageAt — must be an
    // inline MAX(createdAt) subquery, never a pre-fetched JS value.
    const chanSet = (upChan as { setValues?: Record<string, unknown> }).setValues!;
    expect(typeof chanSet.messageCount).toBe("object"); // Drizzle SQL fragment
    expect(typeof chanSet.lastMessageAt).toBe("object");
    expect(chanSet.messageCount).not.toBe(0); // not a pre-fetched literal
    // Read-state UPDATE must revert to the prior message's id/seq/createdAt.
    const rsSet = (upRs as { setValues?: Record<string, unknown> }).setValues!;
    expect(rsSet.lastReadMessageId).toBe("msg_0");
    expect(rsSet.lastReadSeq).toBe(4);
    expect(rsSet.lastReadAt).toBe("2026-01-01T00:00:04Z");
  });

  it("channel + NO prior message (first-ever sender) → batch(delete-msg, update-channel, DELETE-readstate)", async () => {
    const state: MockState = {
      batchCalls: [],
      selectQueue: [
        {
          shape: "message",
          rows: [
            {
              id: "msg_1",
              channelId: "chan_1",
              dmConversationId: null,
              authorId: "user_1",
              seq: 1,
              createdAt: "2026-01-01T00:00:01Z",
            },
          ],
        },
        { shape: "prior", rows: [] },
      ],
    };
    await queries.communityMessage.hardDeleteMessage(makeDb(state), "msg_1");
    const kinds = state.batchCalls[0]!.map((t) => t.kind);
    expect(kinds).toEqual(["delete-msg", "update-channel", "delete-readstate"]);
  });

  it("DM channel + prior message → batch(delete-msg, update-channel, update-readstate) — a DM is a channel now", async () => {
    const state: MockState = {
      batchCalls: [],
      selectQueue: [
        {
          shape: "message",
          rows: [
            {
              id: "msg_1",
              channelId: "dm_chan_1",
              authorId: "user_1",
              seq: 3,
              createdAt: "2026-01-01T00:00:03Z",
            },
          ],
        },
        {
          shape: "prior",
          rows: [{ id: "msg_0", seq: 2, createdAt: "2026-01-01T00:00:02Z" }],
        },
      ],
    };
    await queries.communityMessage.hardDeleteMessage(makeDb(state), "msg_1");
    const [, upChan, upRs] = state.batchCalls[0]!;
    const kinds = state.batchCalls[0]!.map((t) => t.kind);
    // DMs are channels now — the scope revert always targets communityChannel,
    // messageCount and all.
    expect(kinds).toEqual(["delete-msg", "update-channel", "update-readstate"]);
    const chanSet = (upChan as { setValues?: Record<string, unknown> }).setValues!;
    expect(typeof chanSet.messageCount).toBe("object"); // Drizzle SQL fragment
    expect(typeof chanSet.lastMessageAt).toBe("object"); // inline SQL subquery
    const rsSet = (upRs as { setValues?: Record<string, unknown> }).setValues!;
    expect(rsSet.lastReadMessageId).toBe("msg_0");
    expect(rsSet.lastReadSeq).toBe(2);
  });

  it("idempotent — SELECT returns no rows → no batch call, no throw", async () => {
    const state: MockState = {
      batchCalls: [],
      selectQueue: [{ shape: "message", rows: [] }],
    };
    await queries.communityMessage.hardDeleteMessage(makeDb(state), "missing");
    expect(state.batchCalls).toHaveLength(0);
  });
});
