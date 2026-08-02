import { describe, it, expect, vi } from "vitest";
import * as invite from "../../src/db/queries/community/invite";

/**
 * `useInvite` armor invariant (Blondie #244 / Simone ★2): the member INSERT and
 * the `uses = uses + 1` bump are ONE atomic `db.batch(...)` wrapped in
 * `withD1Retry`. This is NOT a cosmetic ordering — it eliminates a silent
 * UNDER-count: with the old sequential `insert; await update`, a transient on
 * the bump AFTER the member insert committed would, on a whole-fn retry, hit the
 * `(serverId, userId)` UNIQUE on the re-insert and rethrow — leaving the member
 * joined but `uses` never incremented (an invite slot silently un-consumed).
 *
 * These tests assert the batch shape + retry behavior directly (the runtime
 * half of the acceptance): the two writes always ride ONE batch, a UNIQUE fails
 * the whole batch (no over-count, no partial), and a retryable transient replays
 * the WHOLE atomic unit (so the second attempt commits member AND bump together
 * — the under-count window is gone).
 */

const INVITE_ROW = {
  id: "inv_1",
  token: "tok",
  serverId: "srv_1",
  maxUses: null as number | null,
  uses: 0,
  expiresAt: null as string | null,
};
const MEMBER_ROW = { id: "mem_1", serverId: "srv_1", userId: "u_1", role: "member", joinedAt: "t0" };
const USER_ROW = { name: "Alice", image: null, discriminator: "0001" };

const UNIQUE_ERR = Object.assign(new Error("UNIQUE constraint failed"), {
  code: "SQLITE_CONSTRAINT_UNIQUE",
});
const BUSY_ERR = new Error("SQLITE_BUSY: database is locked");

/**
 * Mock db where the member INSERT and the `uses` UPDATE resolve as opaque
 * statement placeholders (NOT awaited individually), and `db.batch(stmts)` is
 * the single controllable execution point — mirroring real Drizzle, where
 * statements passed to `db.batch([...])` are executed atomically by the batch,
 * not each awaited on its own. The validation SELECT and the WS-hydration SELECT
 * resolve from `selectQueue`. `update().set().where()` returns its own statement
 * placeholder (a distinct `.where`) so it never consumes a SELECT row.
 */
function makeDb(batchImpl: (stmts: unknown[]) => Promise<unknown>) {
  const selectQueue: unknown[][] = [[INVITE_ROW], [USER_ROW]];
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};

  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  // SELECT terminal — validation invite lookup, then user hydration.
  chain.where = vi.fn(() => Promise.resolve(selectQueue.shift() ?? []));

  // INSERT statement builder — `.returning()` yields a placeholder handed to batch.
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => ({ __stmt: "insert" }));

  // UPDATE statement builder — `.set().where()` yields its OWN placeholder via a
  // separate `.where` so it can't be mistaken for a SELECT terminal.
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn(() => ({ where: vi.fn(() => ({ __stmt: "update" })) }));

  chain.batch = vi.fn(batchImpl);

  return chain;
}

describe("useInvite — member insert + uses bump are one atomic batch (armor)", () => {
  it("runs the member INSERT and the uses bump in ONE db.batch (atomic unit)", async () => {
    const db = makeDb(async () => [[MEMBER_ROW], []]);

    const result = await invite.useInvite(db as never, "tok", "u_1");

    expect(result).not.toBeNull();
    expect(result!.member.id).toBe("mem_1");
    // The load-bearing invariant: exactly ONE batch call carrying BOTH writes,
    // so member-insert and uses-bump commit together or not at all.
    expect(db.batch).toHaveBeenCalledTimes(1);
    const stmts = db.batch.mock.calls[0][0] as Array<{ __stmt: string }>;
    expect(stmts).toHaveLength(2);
    expect(stmts.map((s) => s.__stmt)).toEqual(["insert", "update"]);
  });

  it("a duplicate join (UNIQUE) fails the WHOLE batch → rethrow, uses never bumped (no over/partial count)", async () => {
    const db = makeDb(async () => {
      throw UNIQUE_ERR;
    });

    // UNIQUE is non-retryable → withD1Retry rethrows immediately; the route maps
    // it to "Already a member". Because both writes are in one atomic batch, the
    // failed insert means the `uses` bump never commits either.
    await expect(invite.useInvite(db as never, "tok", "u_dup")).rejects.toThrow(/UNIQUE/);
    // One batch attempt, no retry (UNIQUE isn't a transient).
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it("a transient (SQLITE_BUSY) replays the WHOLE atomic unit → member + uses commit together (no under-count)", async () => {
    // First batch attempt hits a retryable transient; withD1Retry replays the
    // ENTIRE batch (insert + bump), and the second attempt commits both. This is
    // the under-count fix: a transient can never leave member-joined-but-uses-
    // not-bumped, because the retry unit IS the atomic write unit.
    const batchImpl = vi
      .fn<(stmts: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(BUSY_ERR)
      .mockResolvedValue([[MEMBER_ROW], []]);
    const db = makeDb(batchImpl);

    const result = await invite.useInvite(db as never, "tok", "u_1");

    expect(result).not.toBeNull();
    expect(result!.member.id).toBe("mem_1");
    // Retried once: two batch attempts, and the successful one carried BOTH
    // writes atomically — never a partial (member without the bump).
    expect(db.batch).toHaveBeenCalledTimes(2);
    const stmts = batchImpl.mock.calls[1][0] as Array<{ __stmt: string }>;
    expect(stmts.map((s) => s.__stmt)).toEqual(["insert", "update"]);
  });
});
