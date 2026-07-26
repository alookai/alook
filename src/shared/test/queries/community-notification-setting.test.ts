import { describe, it, expect, vi } from "vitest";
import * as notif from "../../src/db/queries/community/notification-setting";

// Each `db.select().from().where()` resolves to the next queued result set.
function createSelectMock(resultSets: unknown[][]) {
  let call = 0;
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(resultSets[call++] ?? []));
  const db: any = { select: vi.fn(() => chain), __chain: chain };
  return db;
}

const TEXT_CHANNEL = { id: "c1", serverId: "s1", parentChannelId: null };
const POST = { id: "p1", serverId: "s1", parentChannelId: "c1" };

describe("community/notification-setting exports", () => {
  it("exports the three effective-level functions", () => {
    expect(typeof notif.computeEffectiveLevel).toBe("function");
    expect(typeof notif.resolveEffectiveLevel).toBe("function");
    expect(typeof notif.resolveEffectiveLevelForUsers).toBe("function");
  });

  it("keeps the CRUD helpers", () => {
    expect(typeof notif.getSettings).toBe("function");
    expect(typeof notif.setServerLevel).toBe("function");
    expect(typeof notif.setChannelLevel).toBe("function");
    expect(typeof notif.removeChannelOverride).toBe("function");
  });

  it("no longer exports the dead getMutedUserIds", () => {
    expect((notif as Record<string, unknown>).getMutedUserIds).toBeUndefined();
  });
});

describe("computeEffectiveLevel — 3-tier climb", () => {
  it("no setting rows at all → global default 'all'", () => {
    expect(notif.computeEffectiveLevel([], TEXT_CHANNEL)).toBe("all");
  });

  it("server-level setting wins when no channel override exists", () => {
    const settings = [{ channelId: null, serverId: "s1", level: "mentions" }];
    expect(notif.computeEffectiveLevel(settings, TEXT_CHANNEL)).toBe("mentions");
  });

  it("channel override beats the server default", () => {
    const settings = [
      { channelId: null, serverId: "s1", level: "all" },
      { channelId: "c1", serverId: null, level: "nothing" },
    ];
    expect(notif.computeEffectiveLevel(settings, TEXT_CHANNEL)).toBe("nothing");
  });

  it("only reads the server row matching the channel's serverId", () => {
    const settings = [{ channelId: null, serverId: "other", level: "nothing" }];
    expect(notif.computeEffectiveLevel(settings, TEXT_CHANNEL)).toBe("all");
  });
});

describe("computeEffectiveLevel — post/thread parent inheritance", () => {
  it("post inherits the parent channel's override when it has none of its own", () => {
    const settings = [{ channelId: "c1", serverId: null, level: "nothing" }];
    expect(notif.computeEffectiveLevel(settings, POST)).toBe("nothing");
  });

  it("post inherits the server default when neither post nor parent has an override", () => {
    const settings = [{ channelId: null, serverId: "s1", level: "mentions" }];
    expect(notif.computeEffectiveLevel(settings, POST)).toBe("mentions");
  });

  it("a sub-channel override beats the parent override", () => {
    const settings = [
      { channelId: "c1", serverId: null, level: "nothing" },
      { channelId: "p1", serverId: null, level: "all" },
    ];
    expect(notif.computeEffectiveLevel(settings, POST)).toBe("all");
  });

  it("post override beats server default and parent absence", () => {
    const settings = [
      { channelId: null, serverId: "s1", level: "all" },
      { channelId: "p1", serverId: null, level: "mentions" },
    ];
    expect(notif.computeEffectiveLevel(settings, POST)).toBe("mentions");
  });

  it("post with no rows → global default 'all'", () => {
    expect(notif.computeEffectiveLevel([], POST)).toBe("all");
  });
});

describe("resolveEffectiveLevel — single user", () => {
  it("returns 'all' when the channel does not exist", async () => {
    const db = createSelectMock([[] /* channel lookup empty */]);
    expect(await notif.resolveEffectiveLevel(db, "u1", "missing")).toBe("all");
  });

  it("climbs to the channel override for the user", async () => {
    const db = createSelectMock([
      [TEXT_CHANNEL],
      [{ userId: "u1", channelId: "c1", serverId: null, level: "nothing" }],
    ]);
    expect(await notif.resolveEffectiveLevel(db, "u1", "c1")).toBe("nothing");
  });

  it("falls back to the server default when the user has no channel row", async () => {
    const db = createSelectMock([
      [TEXT_CHANNEL],
      [{ userId: "u1", channelId: null, serverId: "s1", level: "mentions" }],
    ]);
    expect(await notif.resolveEffectiveLevel(db, "u1", "c1")).toBe("mentions");
  });
});

describe("resolveEffectiveLevelForUsers — batch", () => {
  it("returns an empty map for no users without touching the db", async () => {
    const db = createSelectMock([]);
    const map = await notif.resolveEffectiveLevelForUsers(db, [], "c1");
    expect(map.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("defaults every user to 'all' when the channel is missing", async () => {
    const db = createSelectMock([[] /* channel lookup empty */]);
    const map = await notif.resolveEffectiveLevelForUsers(db, ["u1", "u2"], "gone");
    expect(map.get("u1")).toBe("all");
    expect(map.get("u2")).toBe("all");
  });

  it("resolves distinct per-user levels on the same channel", async () => {
    const db = createSelectMock([
      [TEXT_CHANNEL],
      [
        { userId: "u1", channelId: "c1", serverId: null, level: "nothing" },
        { userId: "u2", channelId: null, serverId: "s1", level: "mentions" },
      ],
    ]);
    const map = await notif.resolveEffectiveLevelForUsers(db, ["u1", "u2", "u3"], "c1");
    expect(map.get("u1")).toBe("nothing");
    expect(map.get("u2")).toBe("mentions");
    expect(map.get("u3")).toBe("all");
  });

  it("fetches the channel once and scopes settings to that channel (single select round for settings)", async () => {
    const db = createSelectMock([
      [POST],
      [
        { userId: "u1", channelId: "c1", serverId: null, level: "nothing" },
        { userId: "u2", channelId: "p1", serverId: null, level: "all" },
      ],
    ]);
    const map = await notif.resolveEffectiveLevelForUsers(db, ["u1", "u2"], "p1");
    // u1 inherits the parent 'nothing'; u2 has a post-level 'all' override.
    expect(map.get("u1")).toBe("nothing");
    expect(map.get("u2")).toBe("all");
    // 1 channel lookup + 1 settings fetch = 2 selects total, regardless of user count.
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
