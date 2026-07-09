import { describe, it, expect, vi } from "vitest";
import * as invite from "../../src/db/queries/community/invite";

/**
 * Build a mock db chain that records the order of high-level operations
 * (`select`, `update`, `insert`) into `ops`. Each terminal method
 * (`.where(...)` on selects, `.returning()` on updates/inserts) resolves
 * with the next queued row set from `rowsQueue`.
 */
function createOrderTrackingDb(rowsQueue: any[][]) {
  const ops: string[] = [];
  const chain: any = {};
  const takeRows = () => Promise.resolve(rowsQueue.shift() ?? []);

  chain.select = vi.fn(() => {
    ops.push("select");
    return chain;
  });
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => takeRows());
  chain.limit = vi.fn(() => takeRows());

  chain.insert = vi.fn(() => {
    ops.push("insert");
    return chain;
  });
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => takeRows());

  chain.update = vi.fn(() => {
    ops.push("update");
    return chain;
  });
  chain.set = vi.fn(() => chain);

  // For update() the terminal method is `.where(...)` — Drizzle's update
  // builder awaits at `.where()`. Handle both shapes by returning a
  // then-able chain that also is awaitable.
  return { chain, ops };
}

describe("useInvite — counter does not increment until member insert succeeds", () => {
  it("runs member INSERT before invite UPDATE (uses ← uses+1)", async () => {
    // Sequence of `.where()`/`.returning()` results, in call order:
    //   1. select invite by token → the invite row
    //   2. insert communityServerMember → returning the inserted row
    //   3. update communityServerInvite (increment uses) — resolves as
    //      Drizzle's update-chain terminal
    //   4. select user (hydration) → user row
    const inviteRow = {
      id: "inv_1",
      token: "tok",
      serverId: "srv_1",
      maxUses: null,
      uses: 0,
      expiresAt: null,
    };
    const memberRow = { id: "mem_1", serverId: "srv_1", userId: "u_1", role: "member" };
    const userRow = { name: "Alice", image: null, discriminator: "0001" };

    const { chain, ops } = createOrderTrackingDb([
      [inviteRow],
      [memberRow],
      [], // update .where(...) result — no rows returned needed
      [userRow],
    ]);

    const result = await invite.useInvite(chain, "tok", "u_1");
    expect(result).not.toBeNull();
    // The load-bearing ordering assertion: insert must come before update.
    const insertIdx = ops.indexOf("insert");
    const updateIdx = ops.indexOf("update");
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(insertIdx);
  });

  it("does NOT run the invite UPDATE if the member INSERT throws (UNIQUE 'already a member')", async () => {
    const inviteRow = {
      id: "inv_1",
      token: "tok",
      serverId: "srv_1",
      maxUses: 3,
      uses: 0,
      expiresAt: null,
    };

    const ops: string[] = [];
    const chain: any = {};
    const rowsQueue: any[][] = [[inviteRow]];
    chain.select = vi.fn(() => {
      ops.push("select");
      return chain;
    });
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rowsQueue.shift() ?? []));
    chain.limit = vi.fn(() => Promise.resolve(rowsQueue.shift() ?? []));
    chain.insert = vi.fn(() => {
      ops.push("insert");
      return chain;
    });
    chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" }),
      ),
    );
    chain.update = vi.fn(() => {
      ops.push("update");
      return chain;
    });
    chain.set = vi.fn(() => chain);

    await expect(invite.useInvite(chain, "tok", "u_dup")).rejects.toThrow(/UNIQUE/);
    expect(ops).toContain("insert");
    // The critical invariant: no UPDATE happened, so `uses` was not
    // incremented on the failed join attempt.
    expect(ops).not.toContain("update");
  });
});
