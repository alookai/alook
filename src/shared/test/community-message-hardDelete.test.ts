import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { queries } from "../src/index";
import type { Database } from "../src/index";

type SelectShape = "message" | "prior";
type Tag =
  | { kind: "revision" }
  | { kind: "delete-msg" }
  | { kind: "update-channel"; setValues?: Record<string, unknown> }
  | { kind: "update-dm"; setValues?: Record<string, unknown> }
  | { kind: "update-readstate"; setValues?: Record<string, unknown> }
  | { kind: "delete-readstate" };

interface MockState {
  batchCalls: Tag[][];
  selectQueue: Array<{ shape: SelectShape; rows: unknown[] }>;
  impactedQueue?: unknown[][];
  revisionRows?: Array<{ userId: string; revision: number }>;
  deletedRows?: Array<{ id: string }>;
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
    b.returning = () => b;
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
    selectDistinct: () => {
      const b: any = {};
      b.from = () => b;
      b.innerJoin = () => b;
      b.where = () => Promise.resolve(state.impactedQueue?.shift() ?? []);
      return b;
    },
    delete: (table: any) => {
      const name = getTableName(table);
      const tag: Tag = name.includes("read_state")
        ? { kind: "delete-readstate" }
        : { kind: "delete-msg" };
      return mkBuilder(tag);
    },
    insert: () => {
      const b = mkBuilder({ kind: "revision" });
      b.select = () => b;
      b.onConflictDoUpdate = () => b;
      return b;
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
      return Promise.resolve(stmts.map((statement) => (
        statement.__tag?.kind === "delete-msg"
          ? state.deletedRows ?? [{ id: "msg_1" }]
          : statement.__tag?.kind === "revision"
            ? state.revisionRows ?? []
            : []
      )));
    },
  };
  return db as Database;
}

describe("hardDeleteMessage — cascading rollback", () => {
  it("channel + prior message exists → repairs pointers before deleting the message", async () => {
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
    const [upChan, upRs, del] = state.batchCalls[0]!;
    expect(upChan.kind).toBe("update-channel");
    expect(upRs.kind).toBe("update-readstate");
    expect(del.kind).toBe("delete-msg");
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

  it("channel + NO prior message (first-ever sender) → removes pointers before deleting the message", async () => {
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
    expect(kinds).toEqual(["update-channel", "delete-readstate", "delete-msg"]);
  });

  it("DM channel + prior message → repairs pointers before deleting the message", async () => {
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
    const [upChan, upRs] = state.batchCalls[0]!;
    const kinds = state.batchCalls[0]!.map((t) => t.kind);
    // DMs are channels now — the scope revert always targets communityChannel,
    // messageCount and all.
    expect(kinds).toEqual(["update-channel", "update-readstate", "delete-msg"]);
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

  it("idempotent — target disappears after selection → no retry and no throw", async () => {
    const state: MockState = {
      batchCalls: [],
      selectQueue: [
        {
          shape: "message",
          rows: [{
            id: "msg_1",
            channelId: "chan_1",
            authorId: "user_1",
            seq: 1,
            createdAt: "2026-01-01T00:00:01Z",
          }],
        },
        { shape: "prior", rows: [] },
        { shape: "message", rows: [] },
      ],
      deletedRows: [],
    };

    await expect(
      queries.communityMessage.hardDeleteMessage(makeDb(state), "msg_1"),
    ).resolves.toBeNull();
    expect(state.batchCalls).toHaveLength(1);
  });

});
