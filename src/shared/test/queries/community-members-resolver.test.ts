import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the underlying channel/member primitives the resolver builds on, so we
// test the resolver's split + source-tagging logic in isolation (no real DB).
const mockIsChannelPrivate = vi.fn<() => Promise<boolean>>();
const mockGetPrivateChannelAudienceUserIds = vi.fn<() => Promise<string[]>>();
const mockListChannelMemberUserIds = vi.fn<() => Promise<string[]>>();
const mockListMemberUserIds = vi.fn<() => Promise<string[]>>();

vi.mock("../../src/db/queries/community/channel", () => ({
  isChannelPrivate: (...a: unknown[]) => mockIsChannelPrivate(...(a as [])),
  getPrivateChannelAudienceUserIds: (...a: unknown[]) =>
    mockGetPrivateChannelAudienceUserIds(...(a as [])),
  listChannelMemberUserIds: (...a: unknown[]) => mockListChannelMemberUserIds(...(a as [])),
}));

vi.mock("../../src/db/queries/community/member", () => ({
  listMemberUserIds: (...a: unknown[]) => mockListMemberUserIds(...(a as [])),
}));

import {
  resolveScopeMemberUserIds,
  resolveScopeMembers,
} from "../../src/db/queries/community/members-resolver";
import type { Database } from "../../src/index";

/**
 * `makeDb` returns a fake Database whose `.select().from().where().limit()`
 * chain resolves to a queued set of rows. The resolver calls `.select` twice
 * for the id path (channel lookup) and more for the member path; we queue rows
 * per invocation so each `await` gets the intended shape.
 */
function makeDb(rowQueues: Record<string, unknown[][]>): Database {
  const counters: Record<string, number> = {};
  const builder = (rows: unknown[]) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.from = () => b;
    b.leftJoin = () => b;
    b.where = () => b;
    b.limit = () => Promise.resolve(rows);
    b.then = (resolve: (v: unknown) => void) => resolve(rows);
    return b;
  };
  // `select` pops the next queued row-set keyed by call order across all
  // `select` invocations. We key queues by a label the tests set up.
  const db = {
    select: () => {
      const key = "select";
      const idx = counters[key] ?? 0;
      counters[key] = idx + 1;
      const q = rowQueues[key] ?? [];
      return builder(q[idx] ?? []);
    },
  } as unknown as Database;
  return db;
}

const CHANNEL = "chan-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveScopeMemberUserIds", () => {
  it("private channel → the private audience (explicit ∪ creator ∪ admins)", async () => {
    mockIsChannelPrivate.mockResolvedValue(true);
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["u1", "u2", "admin1"]);
    const db = makeDb({ select: [[{ serverId: "srv-1" }]] });

    const ids = await resolveScopeMemberUserIds(db, { scope: "channel", scopeId: CHANNEL });

    expect(ids).toEqual(["u1", "u2", "admin1"]);
    expect(mockGetPrivateChannelAudienceUserIds).toHaveBeenCalledTimes(1);
    expect(mockListMemberUserIds).not.toHaveBeenCalled();
  });

  it("public / uncategorized channel → all server members (unfiltered)", async () => {
    mockIsChannelPrivate.mockResolvedValue(false);
    mockListMemberUserIds.mockResolvedValue(["u1", "u2", "u3"]);
    const db = makeDb({ select: [[{ serverId: "srv-1" }]] });

    const ids = await resolveScopeMemberUserIds(db, { scope: "channel", scopeId: CHANNEL });

    expect(ids).toEqual(["u1", "u2", "u3"]);
    expect(mockListMemberUserIds).toHaveBeenCalledTimes(1);
    expect(mockGetPrivateChannelAudienceUserIds).not.toHaveBeenCalled();
  });

  it("forum resolves identically to channel (delegates to the same primitives)", async () => {
    mockIsChannelPrivate.mockResolvedValue(true);
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["u1"]);
    const db = makeDb({ select: [[{ serverId: "srv-1" }]] });

    const ids = await resolveScopeMemberUserIds(db, { scope: "forum", scopeId: CHANNEL });
    expect(ids).toEqual(["u1"]);
  });

  it("unknown channel → empty (scope isolation — nothing leaks)", async () => {
    const db = makeDb({ select: [[]] }); // channel lookup returns no rows
    const ids = await resolveScopeMemberUserIds(db, { scope: "channel", scopeId: "nope" });
    expect(ids).toEqual([]);
    expect(mockIsChannelPrivate).not.toHaveBeenCalled();
  });
});

describe("resolveScopeMembers — source tagging", () => {
  it("public channel: owner/admin → admin, plain member → inherited", async () => {
    mockIsChannelPrivate.mockResolvedValue(false);
    mockListMemberUserIds.mockResolvedValue(["owner1", "admin1", "member1"]);
    const db = makeDb({
      select: [
        [{ serverId: "srv-1" }], // resolveScopeMemberUserIds channel lookup
        [{ serverId: "srv-1" }], // resolveScopeMembers target lookup
        [ // role rows
          { userId: "owner1", role: "owner" },
          { userId: "admin1", role: "admin" },
          { userId: "member1", role: "member" },
        ],
      ],
    });

    const members = await resolveScopeMembers(db, { scope: "channel", scopeId: CHANNEL });

    expect(members).toEqual([
      { userId: "owner1", role: "owner", source: "admin" },
      { userId: "admin1", role: "admin", source: "admin" },
      { userId: "member1", role: "member", source: "inherited" },
    ]);
  });

  it("private channel: explicit member/creator → explicit, others → admin", async () => {
    mockIsChannelPrivate.mockResolvedValue(true);
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["member1", "creator1", "admin1"]);
    mockListChannelMemberUserIds.mockResolvedValue(["member1"]);
    const db = makeDb({
      select: [
        [{ serverId: "srv-1" }], // resolveScopeMemberUserIds channel lookup
        // resolveScopeMembers target lookup — top-level channel is its own
        // anchor, so its creatorId is read directly (no separate anchor query).
        [{ id: CHANNEL, serverId: "srv-1", parentChannelId: null, creatorId: "creator1" }],
        [ // role rows
          { userId: "member1", role: "member" },
          { userId: "creator1", role: "member" },
          { userId: "admin1", role: "admin" },
        ],
      ],
    });

    const members = await resolveScopeMembers(db, { scope: "channel", scopeId: CHANNEL });

    expect(members).toEqual([
      { userId: "member1", role: "member", source: "explicit" },
      { userId: "creator1", role: "member", source: "explicit" },
      { userId: "admin1", role: "admin", source: "admin" },
    ]);
  });
});
