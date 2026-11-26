import { describe, expect, it, vi } from "vitest";
import { resolveNotificationEligibilityForUsers } from "../../src/db/queries/community/notification-eligibility";

function createSelectMock(resultSets: unknown[][]) {
  let call = 0;
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(resultSets[call++] ?? []));
  return { select: vi.fn(() => chain), __chain: chain } as any;
}

describe("resolveNotificationEligibilityForUsers", () => {
  it("returns no rows without querying for an empty recipient set", async () => {
    const db = createSelectMock([]);

    await expect(resolveNotificationEligibilityForUsers(db, [], "m1")).resolves.toEqual(new Map());
    expect(db.select).not.toHaveBeenCalled();
  });

  it("resolves more than 90 recipients in a single JSON-set query and preserves policy, attention, and cursor state", async () => {
    const userIds = Array.from({ length: 150 }, (_, index) => `u${index}`);
    const rows = userIds.map((userId, index) => ({
      userId,
      currentLevel: index === 0 ? "nothing" : index === 120 ? "mentions" : "all",
      hasAttention: index === 120 ? 1 : 0,
      isUnread: index === 149 ? 0 : 1,
      isReadable: index === 89 ? 0 : 1,
    }));
    const db = createSelectMock([rows]);

    const result = await resolveNotificationEligibilityForUsers(db, userIds, "m1");

    expect(result).toHaveLength(150);
    expect(result.get("u0")).toEqual({ currentLevel: "nothing", hasAttention: false, isUnread: true, isReadable: true });
    expect(result.get("u89")).toEqual({ currentLevel: "all", hasAttention: false, isUnread: true, isReadable: false });
    expect(result.get("u120")).toEqual({ currentLevel: "mentions", hasAttention: true, isUnread: true, isReadable: true });
    expect(result.get("u149")).toEqual({ currentLevel: "all", hasAttention: false, isUnread: false, isReadable: true });
    // 1 outer select + 1 jsonTextSet subquery builder = 2 select invocations, 1 outer join.
    expect(db.__chain.leftJoin).toHaveBeenCalledTimes(1);
  });
});
