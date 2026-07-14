import { describe, it, expect, vi } from "vitest";
import * as threadQueries from "../../src/db/queries/community/thread";

describe("community/thread exports", () => {
  it("exports the participant CRUD", () => {
    expect(typeof threadQueries.addThreadParticipant).toBe("function");
    expect(typeof threadQueries.listThreadParticipantUserIds).toBe("function");
    expect(typeof threadQueries.listThreadParticipants).toBe("function");
    expect(typeof threadQueries.removeThreadParticipant).toBe("function");
    expect(typeof threadQueries.setThreadParticipantMuted).toBe("function");
    expect(typeof threadQueries.listParticipatingThreadIds).toBe("function");
  });
});

describe("addThreadParticipant", () => {
  function insertMock(returned: any[]) {
    const chain: any = {};
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.onConflictDoNothing = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve(returned));
    return chain;
  }

  it("returns the inserted row for a new participant", async () => {
    const db = insertMock([{ id: "tp1", threadChannelId: "t1", userId: "u1" }]);
    const res = await threadQueries.addThreadParticipant(db, {
      threadChannelId: "t1",
      userId: "u1",
      source: "spoke",
    });
    expect(res).toMatchObject({ id: "tp1" });
  });

  it("returns null on conflict (already a participant)", async () => {
    const db = insertMock([]);
    const res = await threadQueries.addThreadParticipant(db, {
      threadChannelId: "t1",
      userId: "u1",
      source: "mention",
    });
    expect(res).toBeNull();
  });
});

describe("addThreadParticipants — bulk", () => {
  it("skips the query entirely for an empty rows list", async () => {
    const chain: any = { insert: vi.fn() };
    await threadQueries.addThreadParticipants(chain, "t1", []);
    expect(chain.insert).not.toHaveBeenCalled();
  });

  it("inserts one row per (userId, source) pair with onConflictDoNothing", async () => {
    const values = vi.fn(() => ({ onConflictDoNothing: vi.fn(() => Promise.resolve()) }));
    const chain: any = { insert: vi.fn(() => ({ values })) };
    await threadQueries.addThreadParticipants(chain, "t1", [
      { userId: "u1", source: "spoke" },
      { userId: "u2", source: "mention" },
    ]);
    expect(chain.insert).toHaveBeenCalledTimes(1); // single bulk insert, not N
    expect(values).toHaveBeenCalledWith([
      { threadChannelId: "t1", userId: "u1", source: "spoke" },
      { threadChannelId: "t1", userId: "u2", source: "mention" },
    ]);
  });
});

describe("listThreadParticipantUserIds — notify set (muted=0)", () => {
  function whereMock(rows: any[]) {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  it("returns only userIds (the query filters muted=0 in SQL)", async () => {
    const db = whereMock([{ userId: "u1" }, { userId: "u2" }]);
    const res = await threadQueries.listThreadParticipantUserIds(db, "t1");
    expect(res).toEqual(["u1", "u2"]);
  });
});

describe("listParticipatingThreadIds", () => {
  function whereMock(rows: any[]) {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  it("returns [] without querying for an empty id list", async () => {
    const db = whereMock([{ threadChannelId: "should_not_be_used" }]);
    const res = await threadQueries.listParticipatingThreadIds(db, [], "u1");
    expect(res).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns the participating thread ids", async () => {
    const db = whereMock([{ threadChannelId: "t1" }, { threadChannelId: "t3" }]);
    const res = await threadQueries.listParticipatingThreadIds(db, ["t1", "t2", "t3"], "u1");
    expect(res).toEqual(["t1", "t3"]);
  });
});
