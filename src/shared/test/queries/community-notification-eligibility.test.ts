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

  it("chunks more than 90 recipients and preserves policy, attention, and cursor state", async () => {
    const userIds = Array.from({ length: 150 }, (_, index) => `u${index}`);
    const first = userIds.slice(0, 89).map((userId, index) => ({
      userId,
      currentLevel: index === 0 ? "nothing" : "all",
      hasAttention: 0,
      isUnread: 1,
      isReadable: 1,
    }));
    const second = userIds.slice(89).map((userId, index) => ({
      userId,
      currentLevel: index === 31 ? "mentions" : "all",
      hasAttention: index === 31 ? 1 : 0,
      isUnread: index === 60 ? 0 : 1,
      isReadable: index === 0 ? 0 : 1,
    }));
    const db = createSelectMock([first, second]);

    const result = await resolveNotificationEligibilityForUsers(db, userIds, "m1");

    expect(result).toHaveLength(150);
    expect(result.get("u0")).toEqual({ currentLevel: "nothing", hasAttention: false, isUnread: true, isReadable: true });
    expect(result.get("u89")).toEqual({ currentLevel: "all", hasAttention: false, isUnread: true, isReadable: false });
    expect(result.get("u120")).toEqual({ currentLevel: "mentions", hasAttention: true, isUnread: true, isReadable: true });
    expect(result.get("u149")).toEqual({ currentLevel: "all", hasAttention: false, isUnread: false, isReadable: true });
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(db.__chain.leftJoin).toHaveBeenCalledTimes(2);
  });
});
