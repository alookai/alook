import { describe, it, expect, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import {
  communityMention,
  communityReadState,
  communityChannelMember,
  communityServerFolderItem,
} from "../../src/db/community-schema";
import * as mentionQueries from "../../src/db/queries/community/mention";
import * as attachmentQueries from "../../src/db/queries/community/attachment";
import * as inboxQueries from "../../src/db/queries/community/inbox";
import * as agentInboxQueries from "../../src/db/queries/community/agent-inbox";
import * as readStateQueries from "../../src/db/queries/community/read-state";
import * as channelQueries from "../../src/db/queries/community/channel";
import * as categoryQueries from "../../src/db/queries/community/category";
import * as memberQueries from "../../src/db/queries/community/member";
import * as reactionQueries from "../../src/db/queries/community/reaction";
import * as dmQueries from "../../src/db/queries/community/dm";
import * as overviewQueries from "../../src/db/queries/overview";
import * as taskQueries from "../../src/db/queries/task";
import * as agentQueries from "../../src/db/queries/agent";
import * as conversationQueries from "../../src/db/queries/conversation";
import * as meetingQueries from "../../src/db/queries/meeting-session";
import { D1_MAX_BIND_PARAMS } from "../../src/db/queries/_chunk";

const fakeDb = drizzle({} as never);

// The REAL number of bind params a multi-row insert emits per row. Drizzle binds
// every non-disabled column of every row (including a $defaultFn primary key and
// literal-default columns), so we count params on the actually-built statement
// rather than trusting the "logical" column count. This locks the caps in
// _chunk usage against schema drift — add a column, this test forces a re-cap.
function paramsPerRow(table: Parameters<typeof fakeDb.insert>[0], row: Record<string, unknown>): number {
  const two = fakeDb
    .insert(table)
    .values([row, row])
    .toSQL();
  return two.params.length / 2;
}

describe("real emitted params per row (pins the insert caps)", () => {
  it("communityMention = 5", () => {
    const p = paramsPerRow(communityMention, {
      messageId: "m1",
      userId: "u1",
      kind: "mention",
    });
    expect(p).toBe(5);
  });

  it("communityReadState = 6", () => {
    const p = paramsPerRow(communityReadState, {
      userId: "u1",
      channelId: "c1",
      lastReadAt: "2026-01-01T00:00:00.000Z",
      lastReadMessageId: "m1",
    });
    expect(p).toBe(6);
  });

  it("communityChannelMember = 6", () => {
    const p = paramsPerRow(communityChannelMember, {
      channelId: "c1",
      userId: "u1",
      relation: "notify",
      source: "mention",
    });
    expect(p).toBe(6);
  });

  it("communityServerFolderItem = 3", () => {
    const p = paramsPerRow(communityServerFolderItem, {
      folderId: "f1",
      serverId: "s1",
      position: 0,
    });
    expect(p).toBe(3);
  });
});

// Capturing db that records each insert's row count and resolves .returning().
function makeInsertCapture() {
  const inserts: number[] = [];
  const db: any = {
    insert: vi.fn(() => {
      const builder: any = {};
      builder.values = vi.fn((rows: unknown[]) => {
        inserts.push(rows.length);
        const chainable: any = {
          returning: vi.fn(() =>
            Promise.resolve((rows as Record<string, unknown>[]).map((r, i) => ({ ...r, id: `row-${inserts.length}-${i}` })))
          ),
          onConflictDoNothing: vi.fn(() => Promise.resolve()),
        };
        return chainable;
      });
      return builder;
    }),
  };
  return { db, inserts };
}

describe("createMentions chunking", () => {
  it("100 userIds → 5 insert statements of ≤20 rows, returns all 100", async () => {
    const { db, inserts } = makeInsertCapture();
    const userIds = Array.from({ length: 100 }, (_, i) => `u${i}`);
    const rows = await mentionQueries.createMentions(db, {
      messageId: "m1",
      userIds,
    });
    // 5 params/row → cap 20 → 100/20 = 5 statements.
    expect(inserts).toEqual([20, 20, 20, 20, 20]);
    for (const n of inserts) expect(n * 5).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    expect(rows).toHaveLength(100);
  });

  it("empty userIds → no insert", async () => {
    const { db, inserts } = makeInsertCapture();
    const rows = await mentionQueries.createMentions(db, { messageId: "m1", userIds: [] });
    expect(inserts).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("21 userIds → 2 statements (20 + 1)", async () => {
    const { db, inserts } = makeInsertCapture();
    const userIds = Array.from({ length: 21 }, (_, i) => `u${i}`);
    await mentionQueries.createMentions(db, { messageId: "m1", userIds });
    expect(inserts).toEqual([20, 1]);
  });
});

// Capturing db for a chunked SELECT that ends in .orderBy(). Returns rows by
// call index (chunk order is deterministic: first chunk = ids[0..89], etc.).
function makeSelectCapture(rowsPerCall: unknown[][]) {
  let call = 0;
  const db: any = {
    select: vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => Promise.resolve(rowsPerCall[call++] ?? []));
      return chain;
    }),
  };
  return { db, callCount: () => call };
}

describe("listByMessageIds chunking + global re-sort", () => {
  it("150 ids → 2 chunks, rows re-sorted globally by (position, createdAt)", async () => {
    // First chunk returns position 2; second chunk returns position 1. A correct
    // global re-sort must put position 1 first even though its chunk ran second
    // (per-chunk order alone would be wrong).
    const { db, callCount } = makeSelectCapture([
      [{ messageId: "m0", position: 2, createdAt: "2026-01-01T00:00:02.000Z" }],
      [{ messageId: "m100", position: 1, createdAt: "2026-01-01T00:00:01.000Z" }],
    ]);
    const ids = Array.from({ length: 150 }, (_, i) => `m${i}`);
    const rows = await attachmentQueries.listByMessageIds(db, ids);
    expect(callCount()).toBe(2); // 150 ids → 2 chunks (90 + 60)
    expect(rows.map((r: any) => r.position)).toEqual([1, 2]);
  });
});

function makeD1SelectCapture() {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          statements.push({ sql, params });
          return { raw: async () => [] };
        },
      };
    },
  };
  return { db: drizzle(client as never), statements };
}

function makeD1Capture(rawResponses: unknown[][][] = []) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const responses = [...rawResponses];
  const client = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          statements.push({ sql, params });
          return {
            raw: async () => responses.shift() ?? [],
            all: async () => ({ results: [] }),
            run: async () => ({ success: true, meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return { db: drizzle(client as never), statements };
}

describe("listEligibleUnreadChannels bound parameters", () => {
  it("95 visible ids use 80-id chunks and keep every statement within D1's limit", async () => {
    const { db, statements } = makeD1SelectCapture();
    const visibleChannelIds = Array.from({ length: 95 }, (_, index) => `channel_${index}`);

    await expect(
      inboxQueries.listEligibleUnreadChannels(db as never, "user_1", visibleChannelIds),
    ).resolves.toEqual([]);

    expect(statements).toHaveLength(2);
    expect(statements.map(({ params }) => params.filter(
      (value) => typeof value === "string" && value.startsWith("channel_"),
    ).length)).toEqual([80, 15]);
    expect(statements.map(({ params }) => params.length)).toEqual([92, 27]);
    for (const { params } of statements) {
      expect(params.length).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    }
  });
});

describe("listUnreadMessagesForAgent bound parameters", () => {
  it("90 allowed channels split at the query's 13-fixed-bind budget", async () => {
    const channelIds = Array.from({ length: 90 }, (_, index) => `channel_${index}`);
    const typeRows = channelIds.map((id) => [id, "text"]);
    const { db, statements } = makeD1Capture([typeRows, [], []]);

    await expect(
      agentInboxQueries.listUnreadMessagesForAgent(db as never, "user_1", {
        max: 2,
        visibleChannelIds: channelIds,
      }),
    ).resolves.toEqual([]);

    expect(statements.map(({ params }) => params.filter(
      (value) => typeof value === "string" && value.startsWith("channel_"),
    ).length)).toEqual([90, 87, 3]);
    expect(statements.map(({ params }) => params.length)).toEqual([90, 100, 16]);
    for (const { params } of statements) {
      expect(params.length).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    }
  });
});

describe("mark-all-read revision guard bound parameters", () => {
  function buildGuard(targetCount: number) {
    const targets = Array.from({ length: targetCount }, (_, index) => ({
      channelId: `channel_${index}`,
      targetSeq: index + 1,
    }));
    const condition = readStateQueries.readStateAdvancesAnyTargetCondition(
      fakeDb as never,
      "user_1",
      targets,
    );
    return readStateQueries
      .advanceReadStateRevisionWhenBuilder(fakeDb as never, "user_1", condition)
      .toSQL();
  }

  it("33 and 95 targets keep one constant-size JSON guard below D1's limit", () => {
    const thirtyThree = buildGuard(33);
    const ninetyFive = buildGuard(95);

    expect(thirtyThree.params).toHaveLength(4);
    expect(ninetyFive.params).toHaveLength(4);
    expect(ninetyFive.params.length).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    expect(ninetyFive.sql).toContain("json_each");
    expect(ninetyFive.sql).toMatch(
      /cast\(json_extract\(read_target\.value, '\$\[1\]'\) as integer\)/i,
    );
    const encodedTargets = ninetyFive.params.find(
      (param) => typeof param === "string" && param.startsWith('[["channel_0",'),
    );
    expect(JSON.parse(encodedTargets as string)).toHaveLength(95);
  });
});

describe("high-cardinality query bind matrix", () => {
  const sizes = [33, 90, 100, 125];

  it.each(sizes)("keeps JSON/subquery reads constant at %i ids", async (size) => {
    const ids = Array.from({ length: size }, (_, index) => `id_${index}`);
    const calls: Array<(db: ReturnType<typeof drizzle>) => Promise<unknown>> = [
      (db) => memberQueries.getMemberships(db as never, "user_1", ids),
      (db) => categoryQueries.getCategoriesByIds(db as never, ids),
      (db) => agentQueries.getAgentsByIds(db as never, ids, "workspace_1"),
      (db) => conversationQueries.getConversationsByIds(db as never, ids, "workspace_1"),
      (db) => overviewQueries.getRecentTerminalTasks(db as never, "workspace_1", ids),
      (db) => overviewQueries.getConversationCountsByAgent(db as never, "workspace_1", ids),
      (db) => taskQueries.listPendingTasksByRuntimes(db as never, ids, "workspace_1"),
      (db) => taskQueries.listActiveTaskCountsByWorkspace(db as never, "workspace_1", ids, "user_1"),
      (db) => taskQueries.listActiveTasksByWorkspace(db as never, "workspace_1", ids, "user_1"),
      (db) => taskQueries.getTraceAgentsByTaskIds(db as never, ids, "workspace_1"),
      (db) => meetingQueries.claimMeetingSessions(db as never, ids, "workspace_1", "2026-01-01T00:00:00.000Z"),
      (db) => dmQueries.listDMs(db as never, "user_1"),
      (db) => dmQueries.getDMBetween(db as never, "user_1", "user_2"),
    ];

    for (const call of calls) {
      const { db, statements } = makeD1Capture();
      await call(db);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement.params.length).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
      }
      expect(statements.some(({ sql }) => sql.includes("json_each")) || call === calls.at(-2) || call === calls.at(-1)).toBe(true);
    }
  });

  it("uses exact 99-id member chunks and 100-id reaction chunks", async () => {
    const ids = Array.from({ length: 125 }, (_, index) => `id_${index}`);
    const memberCapture = makeD1Capture();
    await memberQueries.getMembersByUserIds(memberCapture.db as never, "server_1", ids);
    expect(memberCapture.statements.map(({ params }) => params.length)).toEqual([100, 27]);

    const reactionCapture = makeD1Capture();
    await reactionQueries.listReactionsByMessageIds(reactionCapture.db as never, ids, "user_1");
    expect(reactionCapture.statements.map(({ params }) => params.length)).toEqual([100, 25]);
  });

  it("uses 100/98 server chunks before the visibility merge", async () => {
    const memberships = Array.from({ length: 125 }, (_, index) => [`server_${index}`]);
    const capture = makeD1Capture([memberships, [], [], [], []]);

    await channelQueries.listVisibleChannelIdsForUser(capture.db as never, "user_1");

    expect(capture.statements.map(({ params }) => params.length)).toEqual([1, 100, 25, 100, 29]);
    for (const { params } of capture.statements) {
      expect(params.length).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    }
  });
});
