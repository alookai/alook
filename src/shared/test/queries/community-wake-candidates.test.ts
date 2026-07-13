import { describe, it, expect, vi } from "vitest";
import { findWakeCandidates } from "../../src/db/queries/community/bot";

// Terminal-where mock — the module chains
// select().from().innerJoin().leftJoin().where(), and `.where()` is the
// terminal call that resolves to rows. `findWakeCandidates` issues exactly
// one `db.select(...)` call — the main candidate query. `sequences` supplies
// one result array per call, in order; a call beyond the supplied
// sequences resolves to []. We don't re-verify the WHERE predicate itself
// here (that's SQL, exercised in e2e/integration); this covers the
// post-fetch filter and row shape, which is the part `enqueueBotWakes`
// actually depends on.
function createSelectMock(...sequences: unknown[][]) {
  let call = 0;
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(sequences[call++] ?? []));
  return chain;
}

describe("findWakeCandidates", () => {
  it("returns [] and never queries when recipients is empty", async () => {
    const db = createSelectMock([{ botUserId: "never", name: "x", machineId: "m", runtime: "claude", lastReadSeq: 0 }]);
    const result = await findWakeCandidates(db as never, {
      recipients: [],
      channelId: "c1",
      newSeq: 5,
    });
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("excludes candidates already caught up (lastReadSeq >= newSeq)", async () => {
    const db = createSelectMock([
      { botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude", lastReadSeq: 3 },
      { botUserId: "bot2", name: "kai", machineId: "m2", runtime: "codex", lastReadSeq: 10 },
    ]);
    const result = await findWakeCandidates(db as never, {
      recipients: ["bot1", "bot2"],
      channelId: "c1",
      newSeq: 7,
    });
    expect(result).toEqual([{ botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude" }]);
  });

  it("treats a NULL lastReadSeq (never read) as behind — included", async () => {
    const db = createSelectMock([
      { botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude", lastReadSeq: null },
    ]);
    const result = await findWakeCandidates(db as never, {
      recipients: ["bot1"],
      channelId: "c1",
      newSeq: 1,
    });
    expect(result).toEqual([{ botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude" }]);
  });

  it("supports dmConversationId scope", async () => {
    const db = createSelectMock([
      { botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude", lastReadSeq: 0 },
    ]);
    const result = await findWakeCandidates(db as never, {
      recipients: ["bot1"],
      dmConversationId: "dm1",
      newSeq: 1,
    });
    expect(result).toEqual([{ botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude" }]);
  });

  it("issues exactly one db.select call — no notification-setting/mention lookups", async () => {
    const db = createSelectMock([
      { botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude", lastReadSeq: 0 },
    ]);
    const result = await findWakeCandidates(db as never, {
      recipients: ["bot1"],
      channelId: "c1",
      newSeq: 1,
    });
    expect(result).toEqual([{ botUserId: "bot1", name: "zoe", machineId: "m1", runtime: "claude" }]);
    expect((db.select as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
