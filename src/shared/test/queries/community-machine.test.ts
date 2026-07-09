import { describe, it, expect, vi } from "vitest";
import * as q from "../../src/db/queries/community/machine";

describe("community/machine exports", () => {
  it("exports the documented helpers", () => {
    expect(typeof q.createPairingToken).toBe("function");
    expect(typeof q.createReconnectPairingToken).toBe("function");
    expect(typeof q.claimPairingToken).toBe("function");
    expect(typeof q.findActiveToken).toBe("function");
    expect(typeof q.findTokenById).toBe("function");
    expect(typeof q.touchTokenLastUsed).toBe("function");
    expect(typeof q.revokeToken).toBe("function");
    expect(typeof q.upsertMachineByMachineId).toBe("function");
    expect(typeof q.touchMachineHeartbeat).toBe("function");
    expect(typeof q.getMachineByIdForUser).toBe("function");
    expect(typeof q.listMachinesForUser).toBe("function");
    expect(typeof q.deleteMachineForUser).toBe("function");
    expect(typeof q.toSummary).toBe("function");
    expect(typeof q.markMachineOffline).toBe("function");
    expect(typeof q.markMachineOnlineIfOffline).toBe("function");
    expect(typeof q.activateMachineCredential).toBe("function");
    expect(typeof q.hashCredential).toBe("function");
    expect(typeof q.doNameFromHash).toBe("function");
    expect(typeof q.findCredentialByHash).toBe("function");
    expect(typeof q.findActiveCredentialByBearer).toBe("function");
    expect(typeof q.revokeCredential).toBe("function");
    expect(typeof q.revokeCredentialsForMachine).toBe("function");
    expect(typeof q.mintAgentRunnerKey).toBe("function");
    expect(typeof q.findActiveAgentRunnerKeyByBearer).toBe("function");
  });

  it("does not export legacy machineUuid helpers", () => {
    expect((q as any).machineUuidFromTokenId).toBeUndefined();
    expect((q as any).tokenIdFromMachineUuid).toBeUndefined();
    expect((q as any).upsertMachineForUser).toBeUndefined();
    expect((q as any).rotatePairingTokenForMachine).toBeUndefined();
    expect((q as any).findActiveCredential).toBeUndefined();
    expect((q as any).findActiveAgentRunnerKey).toBeUndefined();
  });
});

describe("hashCredential", () => {
  it("returns lowercase hex of length 64 (sha256)", async () => {
    const h = await q.hashCredential("cmk_hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is deterministic for the same input", async () => {
    const a = await q.hashCredential("cmk_abc123");
    const b = await q.hashCredential("cmk_abc123");
    expect(a).toBe(b);
  });
  it("differs for different inputs", async () => {
    const a = await q.hashCredential("cmk_a");
    const b = await q.hashCredential("cmk_b");
    expect(a).not.toBe(b);
  });
});

describe("doNameFromHash", () => {
  it("returns the first 32 chars of the hash", async () => {
    const h = await q.hashCredential("cmk_abc");
    expect(q.doNameFromHash(h)).toBe(h.slice(0, 32));
    expect(q.doNameFromHash(h)).toHaveLength(32);
  });
});

describe("toSummary", () => {
  it("returns row.status verbatim (source of truth is the column)", () => {
    const now = new Date().toISOString();
    const s = q.toSummary({
      id: "cm_x",
      userId: "u_1",
      displayName: "host",
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      osRelease: "23.6.0",
      daemonVersion: "0.1.0",
      metadata: null,
      availableRuntimes: [],
      status: "online",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(s.id).toBe("cm_x");
    expect(s.hostname).toBe("host");
    expect(s.status).toBe("online");
    expect(s.availableRuntimes).toEqual([]);
  });
  it("returns offline verbatim when the column says so, even with a fresh lastSeenAt", () => {
    const now = new Date().toISOString();
    const s = q.toSummary({
      id: "cm_x",
      userId: "u_1",
      displayName: "host",
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      osRelease: "23.6.0",
      daemonVersion: "0.1.0",
      metadata: null,
      availableRuntimes: [],
      status: "offline",
      // Deliberately recent lastSeenAt — status is no longer derived from it.
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(s.status).toBe("offline");
  });
  it("passes through availableRuntimes when populated", () => {
    const now = new Date().toISOString();
    const s = q.toSummary({
      id: "cm_x",
      userId: "u_1",
      displayName: "host",
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      osRelease: "23.6.0",
      daemonVersion: "0.1.0",
      metadata: null,
      availableRuntimes: [{ id: "claude", version: "1.0.0" }],
      status: "online",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(s.availableRuntimes).toEqual([{ id: "claude", version: "1.0.0" }]);
  });
});

// ---------------------------------------------------------------------------
// markMachineOffline / markMachineOnlineIfOffline
// ---------------------------------------------------------------------------

function makeUpdateChain(returningRows: unknown[]) {
  const chain: any = {};
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(returningRows));
  return chain;
}

describe("markMachineOffline", () => {
  it("flips status='online' → 'offline' when the row matches + credential is active (returns updated row)", async () => {
    const flipped = { id: "cm_1", userId: "u_1", status: "offline", lastSeenAt: "now" };
    const chain = makeUpdateChain([flipped]);
    const out = await q.markMachineOffline(chain, {
      userId: "u_1",
      machineId: "cm_1",
      credentialHash: "abc",
    });
    expect(out).toEqual(flipped);
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "offline" })
    );
  });
  it("returns null when the row is already offline / credential revoked / wrong user (guarded UPDATE returned zero rows)", async () => {
    const chain = makeUpdateChain([]);
    const out = await q.markMachineOffline(chain, {
      userId: "u_1",
      machineId: "cm_1",
      credentialHash: "revoked",
    });
    expect(out).toBeNull();
  });
});

describe("markMachineOnlineIfOffline", () => {
  it("flips offline → online when guarded row + credential are active", async () => {
    const flipped = { id: "cm_1", userId: "u_1", status: "online", lastSeenAt: "now" };
    const chain = makeUpdateChain([flipped]);
    const out = await q.markMachineOnlineIfOffline(chain, {
      userId: "u_1",
      machineId: "cm_1",
      credentialHash: "abc",
    });
    expect(out).toEqual(flipped);
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "online" })
    );
  });
  it("returns null when the row is already online or credential revoked", async () => {
    const chain = makeUpdateChain([]);
    const out = await q.markMachineOnlineIfOffline(chain, {
      userId: "u_1",
      machineId: "cm_1",
      credentialHash: "abc",
    });
    expect(out).toBeNull();
  });
});

describe("claimPairingToken", () => {
  it("rejects when no rows are returned (not claimable)", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    await expect(q.claimPairingToken(chain, "cmt_abc")).rejects.toThrow(/not claimable/);
  });
  it("returns the single winner row", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([{ id: "cmt_abc", userId: "u_1" }]));
    const r = await q.claimPairingToken(chain, "cmt_abc");
    expect(r).toEqual({ tokenId: "cmt_abc", userId: "u_1" });
  });
});

describe("isBotOnline", () => {
  function makeJoinChain(rows: unknown[]) {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  it("returns true when the bound machine is online", async () => {
    const chain = makeJoinChain([{ status: "online" }]);
    expect(await q.isBotOnline(chain, "bot_1")).toBe(true);
  });

  it("returns false when the bound machine is offline", async () => {
    const chain = makeJoinChain([{ status: "offline" }]);
    expect(await q.isBotOnline(chain, "bot_1")).toBe(false);
  });

  it("returns false when the bot has no machine binding", async () => {
    const chain = makeJoinChain([]);
    expect(await q.isBotOnline(chain, "bot_1")).toBe(false);
  });

  it("joins the user table so a soft-deleted bot's row is excluded (mirrors listBotsForMachine's guard)", async () => {
    // A real DB would filter the join itself; this mock always returns the
    // row, so the assertion is structural — the query must join `user` at
    // all, not just `communityBotBinding`/`communityMachine`, so a
    // `deletedAt` filter has somewhere to apply.
    const chain = makeJoinChain([{ status: "online" }]);
    await q.isBotOnline(chain, "bot_1");
    expect(chain.innerJoin).toHaveBeenCalledTimes(2);
  });
});

describe("findActiveToken", () => {
  it("returns null when no row matches", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    expect(await q.findActiveToken(chain, "cmt_x")).toBeNull();
  });
  it("returns the row when present", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([{ id: "cmt_x", userId: "u_1" }]));
    expect(await q.findActiveToken(chain, "cmt_x")).toEqual({
      tokenId: "cmt_x",
      userId: "u_1",
    });
  });
});

describe("findTokenById returns machineId (nullable)", () => {
  it("passes through null machineId for first-pair tokens", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() =>
      Promise.resolve([
        {
          id: "cmt_a",
          userId: "u_1",
          machineId: null,
          status: "pending",
          expiresAt: "9999",
        },
      ])
    );
    const r = await q.findTokenById(chain, "cmt_a");
    expect(r?.machineId).toBeNull();
  });
  it("returns bound machineId for reconnect tokens", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() =>
      Promise.resolve([
        {
          id: "cmt_a",
          userId: "u_1",
          machineId: "cm_existing",
          status: "pending",
          expiresAt: "9999",
        },
      ])
    );
    const r = await q.findTokenById(chain, "cmt_a");
    expect(r?.machineId).toBe("cm_existing");
  });
});

describe("createPairingToken", () => {
  function makeChain(insertRows: Array<{ id: string; expiresAt: string }>) {
    const chain: any = {};
    // update().set().where() — awaited directly, returns nothing meaningful
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve());
    // insert().values().returning()
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve(insertRows));
    return chain;
  }

  it("revokes any existing pending token for the user before insert", async () => {
    const chain = makeChain([{ id: "cmt_new", expiresAt: "future" }]);
    await q.createPairingToken(chain, "u_1");
    expect(chain.update).toHaveBeenCalled();
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "revoked" })
    );
    // update() ran before insert() — both were called
    expect(chain.insert).toHaveBeenCalled();
    const updateOrder = chain.update.mock.invocationCallOrder[0];
    const insertOrder = chain.insert.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(insertOrder);
  });

  it("inserts a pending token and returns id + expiry", async () => {
    const chain = makeChain([{ id: "cmt_new", expiresAt: "future" }]);
    const r = await q.createPairingToken(chain, "u_1");
    expect(r).toEqual({ tokenId: "cmt_new", expiresAt: "future" });
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_1", machineId: null, status: "pending" })
    );
  });

  it("passes through machineId when supplied (reconnect path)", async () => {
    const chain = makeChain([{ id: "cmt_new", expiresAt: "future" }]);
    await q.createPairingToken(chain, "u_1", { machineId: "cm_x" });
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: "cm_x" })
    );
  });
});

describe("createReconnectPairingToken", () => {
  it("rejects when machine is not owned by the user", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    await expect(
      q.createReconnectPairingToken(chain, "u_1", "cm_other")
    ).rejects.toThrow(/not owned by user/);
  });

  it("mints a machine-bound token on success", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    // select().from().where().limit() → owned row; update().set().where() → pre-revoke
    let whereCallCount = 0;
    chain.where = vi.fn(() => {
      whereCallCount += 1;
      // 2nd where() is the pre-revoke tail; resolves to nothing
      return whereCallCount >= 2 ? Promise.resolve() : chain;
    });
    chain.limit = vi.fn(() => Promise.resolve([{ id: "cm_x" }]));
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() =>
      Promise.resolve([{ id: "cmt_new", expiresAt: "future" }])
    );
    const r = await q.createReconnectPairingToken(chain, "u_1", "cm_x");
    expect(r).toEqual({ tokenId: "cmt_new", expiresAt: "future" });
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: "cm_x" })
    );
  });
});

// ---------------------------------------------------------------------------
// upsertMachineByMachineId
// ---------------------------------------------------------------------------

describe("upsertMachineByMachineId", () => {
  const priorRow = {
    id: "cm_1",
    userId: "u_1",
    displayName: "host",
    hostname: "host",
    platform: "darwin",
    arch: "arm64",
    osRelease: "23",
    daemonVersion: "0.1.0",
    metadata: null,
    availableRuntimes: [{ id: "claude" }],
    status: "offline" as const,
    lastSeenAt: "earlier",
    createdAt: "earlier",
    updatedAt: "earlier",
  };

  it("returns null when the machine row is missing", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    expect(
      await q.upsertMachineByMachineId(chain, "u_1", "cm_missing", {})
    ).toBeNull();
  });

  it("passes availableRuntimes through the update when supplied", async () => {
    const updated = { ...priorRow, availableRuntimes: [{ id: "claude" }, { id: "codex" }] };
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([priorRow]));
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([updated]));
    const res = await q.upsertMachineByMachineId(chain, "u_1", "cm_1", {
      availableRuntimes: [{ id: "claude" }, { id: "codex" }],
    });
    expect(res?.priorAvailableRuntimes).toEqual([{ id: "claude" }]);
    expect(res?.machine.availableRuntimes).toEqual([{ id: "claude" }, { id: "codex" }]);
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        availableRuntimes: [{ id: "claude" }, { id: "codex" }],
      })
    );
  });

  it("preserves prior availableRuntimes when caller passes undefined", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([priorRow]));
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([priorRow]));
    await q.upsertMachineByMachineId(chain, "u_1", "cm_1", { hostname: "host2" });
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ availableRuntimes: [{ id: "claude" }] })
    );
  });

  it("writes status='online' on every ready-frame upsert (the DO gates broadcast on priorStatus)", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([priorRow]));
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.returning = vi.fn(() =>
      Promise.resolve([{ ...priorRow, status: "online", lastSeenAt: "now" }])
    );
    await q.upsertMachineByMachineId(chain, "u_1", "cm_1", { hostname: "host2" });
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ status: "online" }));
  });

  it("returns priorStatus='offline' when the row was offline before the upsert", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([priorRow]));
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.returning = vi.fn(() =>
      Promise.resolve([{ ...priorRow, status: "online", lastSeenAt: "now" }])
    );
    const res = await q.upsertMachineByMachineId(chain, "u_1", "cm_1", {});
    expect(res?.priorStatus).toBe("offline");
  });

  it("returns priorStatus='online' when the row was already online (repeat ready-frame)", async () => {
    const onlinePrior = { ...priorRow, status: "online" as const };
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([onlinePrior]));
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([onlinePrior]));
    const res = await q.upsertMachineByMachineId(chain, "u_1", "cm_1", {});
    expect(res?.priorStatus).toBe("online");
  });

  it("leaves status/lastSeenAt untouched when markOnline=false (HTTP /activate reconnect)", async () => {
    // /activate runs before the daemon's WS connects — it must not flip
    // status itself, or the later `ready`-frame's `priorStatus !== 'online'`
    // guard would wrongly see 'online' and skip the broadcast (incl. bot
    // presence fan-out). Only the real ready-frame call (default
    // markOnline=true) may set status.
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([priorRow]));
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([priorRow]));
    const res = await q.upsertMachineByMachineId(
      chain,
      "u_1",
      "cm_1",
      { hostname: "host2" },
      { markOnline: false }
    );
    expect(chain.set).toHaveBeenCalledWith(
      expect.not.objectContaining({ status: expect.anything() })
    );
    const setArg = chain.set.mock.calls[0][0];
    expect(setArg).not.toHaveProperty("status");
    expect(setArg).not.toHaveProperty("lastSeenAt");
    // priorStatus still reflects the pre-upsert row (offline), unaffected
    // by markOnline — it's purely about what gets WRITTEN.
    expect(res?.priorStatus).toBe("offline");
  });
});

// ---------------------------------------------------------------------------
// activateMachineCredential
// ---------------------------------------------------------------------------

describe("activateMachineCredential — validation", () => {
  it("throws 'unknown' when the token is not in the DB", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    await expect(
      q.activateMachineCredential(chain, "cmt_unknown", { hostname: "" })
    ).rejects.toBeInstanceOf(q.ActivateCredentialError);
    try {
      await q.activateMachineCredential(chain, "cmt_unknown", { hostname: "" });
    } catch (err) {
      expect((err as q.ActivateCredentialError).kind).toBe("unknown");
    }
  });

  it("throws 'revoked' when token status is revoked", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() =>
      Promise.resolve([
        {
          id: "cmt_x",
          userId: "u_1",
          machineId: null,
          status: "revoked",
          expiresAt: "9999",
        },
      ])
    );
    try {
      await q.activateMachineCredential(chain, "cmt_x", { hostname: "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as q.ActivateCredentialError).kind).toBe("revoked");
    }
  });

  it("throws 'already_active' when token status is active", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() =>
      Promise.resolve([
        {
          id: "cmt_x",
          userId: "u_1",
          machineId: null,
          status: "active",
          expiresAt: "9999",
        },
      ])
    );
    try {
      await q.activateMachineCredential(chain, "cmt_x", { hostname: "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as q.ActivateCredentialError).kind).toBe("already_active");
    }
  });

  it("throws 'expired' when expiresAt is past", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() =>
      Promise.resolve([
        {
          id: "cmt_x",
          userId: "u_1",
          machineId: null,
          status: "pending",
          expiresAt: "1970-01-01T00:00:00Z",
        },
      ])
    );
    try {
      await q.activateMachineCredential(chain, "cmt_x", { hostname: "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as q.ActivateCredentialError).kind).toBe("expired");
    }
  });
});

/**
 * activateMachineCredential success paths use a scripted mock that returns
 * different results per call. Kept minimal — the interesting behavior is:
 * (1) new-pair path creates a machine row via insert;
 * (2) reconnect path (token.machineId set) reuses via update;
 * (3) either path stores credential_hash + do_name and returns the plaintext.
 */
describe("activateMachineCredential — success paths", () => {
  function scriptChain(script: Array<() => Promise<any>>) {
    let step = 0;
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => script[step++]!());
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.returning = vi.fn(() => script[step++]!());
    chain.insert = vi.fn(() => chain);
    // Values captured for assertion
    chain._insertValues = [] as any[];
    chain.values = vi.fn((v: any) => {
      chain._insertValues.push(v);
      return chain;
    });
    return chain;
  }

  it("new-pair path — inserts a new machine row and stores credential_hash + do_name", async () => {
    const nowStub = "2026-07-02T00:00:00.000Z";
    const insertedMachine = {
      id: "cm_new",
      userId: "u_1",
      displayName: "host",
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      osRelease: "23",
      daemonVersion: "0.1.0",
      metadata: null,
      availableRuntimes: [],
      lastSeenAt: nowStub,
      createdAt: nowStub,
      updatedAt: nowStub,
    };

    // Scripted results in call order:
    // 1. select token row (limit) → pending, no machineId
    // 2. update token pending→revoked (returning) → row
    // 3. insert machine (returning) → machine row
    // 4. insert credential — no returning
    const chain = scriptChain([
      // (1) findToken
      () =>
        Promise.resolve([
          {
            id: "cmt_x",
            userId: "u_1",
            machineId: null,
            status: "pending",
            expiresAt: "9999",
          },
        ]),
      // (2) flip returning
      () => Promise.resolve([{ id: "cmt_x" }]),
      // (3) insert machine returning
      () => Promise.resolve([insertedMachine]),
    ]);

    const r = await q.activateMachineCredential(chain, "cmt_x", {
      hostname: "host",
    });
    expect(r.userId).toBe("u_1");
    expect(r.machineId).toBe("cm_new");
    expect(r.credential.startsWith("cmk_")).toBe(true);

    // Credential row insert must have set credential_hash + do_name.
    const credInsert = chain._insertValues.find(
      (v: any) => v.credentialHash && v.doName
    );
    expect(credInsert).toBeTruthy();
    expect(credInsert.credentialHash).toMatch(/^[0-9a-f]{64}$/);
    expect(credInsert.doName).toBe(credInsert.credentialHash.slice(0, 32));
    // The hash stored must match sha256(returned plaintext bearer).
    const expectedHash = await q.hashCredential(r.credential);
    expect(credInsert.credentialHash).toBe(expectedHash);
  });

  it("reconnect path — reuses existing machine row and revokes prior credentials", async () => {
    const existingMachine = {
      id: "cm_existing",
      userId: "u_1",
      displayName: "host",
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      osRelease: "23",
      daemonVersion: "0.1.0",
      metadata: null,
      availableRuntimes: [],
      lastSeenAt: "earlier",
      createdAt: "earlier",
      updatedAt: "earlier",
    };

    // Scripted (limit / returning) in call order:
    // 1. select token row → pending, machineId set
    // 2. flip token returning
    // 3. select machine row inside upsertMachineByMachineId → prior
    // 4. update machine returning → updated
    // 5. update prior credentials revokedAt — no returning
    const chain = scriptChain([
      // (1) find token
      () =>
        Promise.resolve([
          {
            id: "cmt_x",
            userId: "u_1",
            machineId: "cm_existing",
            status: "pending",
            expiresAt: "9999",
          },
        ]),
      // (2) flip returning
      () => Promise.resolve([{ id: "cmt_x" }]),
      // (3) upsertMachineByMachineId select prior
      () => Promise.resolve([existingMachine]),
      // (4) upsertMachineByMachineId update returning
      () => Promise.resolve([existingMachine]),
    ]);

    const r = await q.activateMachineCredential(chain, "cmt_x", {
      hostname: "host",
    });
    expect(r.machineId).toBe("cm_existing");
    // Update was called at least twice — once for machine, once for revoking
    // prior credentials.
    expect(chain.update).toHaveBeenCalled();
    // Reconnect activation must not flip status/lastSeenAt itself — that's
    // reserved for the real WS `ready` frame (see upsertMachineByMachineId's
    // markOnline doc comment). Find the machine-row `.set()` call (the one
    // touching `hostname`) and assert it carries no status.
    const machineSetCall = chain.set.mock.calls.find(
      (args: any[]) => args[0] && "hostname" in args[0]
    );
    expect(machineSetCall?.[0]).not.toHaveProperty("status");
    expect(machineSetCall?.[0]).not.toHaveProperty("lastSeenAt");
  });

  it("leaves the token revoked (not rolled back) when the reconnect target machine is missing", async () => {
    // If the machine row was deleted between mint and activate, we CANNOT
    // roll the token back to `pending` — a `pending` token that references
    // a missing machine will loop the daemon forever and the pending-token
    // unique index blocks the user from minting a fresh pair token for
    // 15 min. So the token stays `revoked` and the user re-pairs.
    let step = 0;
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => {
      const idx = step++;
      if (idx === 0) {
        return Promise.resolve([
          {
            id: "cmt_x",
            userId: "u_1",
            machineId: "cm_bad",
            status: "pending",
            expiresAt: "9999",
          },
        ]);
      }
      if (idx === 2) return Promise.resolve([]); // upsert → missing machine
      return Promise.resolve([]);
    });
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([{ id: "cmt_x" }]));
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);

    await expect(
      q.activateMachineCredential(chain, "cmt_x", { hostname: "" })
    ).rejects.toMatchObject({ name: "ActivateCredentialError", kind: "unknown" });

    const setPayloads = chain.set.mock.calls.map((c: any[]) => c[0]);
    const rolledBack = setPayloads.some((p: any) => p.status === "pending");
    expect(rolledBack).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findCredentialByHash / findActiveCredentialByBearer
// ---------------------------------------------------------------------------

describe("findCredentialByHash", () => {
  it("returns null when no active row matches", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    expect(await q.findCredentialByHash(chain, "deadbeef")).toBeNull();
  });

  it("returns the row on hit and bumps last_used_at", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() =>
      Promise.resolve([
        {
          id: "cmkid_a",
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "h",
          doName: "d",
        },
      ])
    );
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    const r = await q.findCredentialByHash(chain, "h");
    expect(r).toEqual({
      credentialId: "cmkid_a",
      userId: "u_1",
      machineId: "cm_1",
      credentialHash: "h",
      doName: "d",
    });
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ lastUsedAt: expect.any(String) })
    );
  });
});

describe("findActiveCredentialByBearer", () => {
  it("returns null for a non-`cmk_` prefix without hitting the DB", async () => {
    const chain: any = {
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
      update: vi.fn(),
      set: vi.fn(),
    };
    expect(await q.findActiveCredentialByBearer(chain, "cmt_wrong")).toBeNull();
    expect(chain.select).not.toHaveBeenCalled();
  });

  it("hashes the bearer and delegates to findCredentialByHash", async () => {
    const bearer = "cmk_test123";
    const hash = await q.hashCredential(bearer);
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    // The .where call receives the drizzle condition; we can't easily peek at
    // the compiled value, so we just assert the limit returns a shaped row.
    chain.limit = vi.fn(() =>
      Promise.resolve([
        {
          id: "cmkid_a",
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: hash,
          doName: hash.slice(0, 32),
        },
      ])
    );
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    const r = await q.findActiveCredentialByBearer(chain, bearer);
    expect(r?.credentialHash).toBe(hash);
    expect(r?.doName).toBe(hash.slice(0, 32));
  });
});

// ---------------------------------------------------------------------------
// mintAgentRunnerKey / findActiveAgentRunnerKeyByBearer
// ---------------------------------------------------------------------------

describe("mintAgentRunnerKey", () => {
  it("hard-deletes an existing row before inserting a fresh bearer", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([{ id: "crkid_old" }]));
    chain.delete = vi.fn(() => chain);
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    const r = await q.mintAgentRunnerKey(chain, {
      userId: "u_1",
      machineId: "cm_1",
      agentId: "agent_a",
    });
    expect(r.existed).toBe(true);
    expect(r.runnerKey.startsWith("crk_")).toBe(true);
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u_1",
        machineId: "cm_1",
        agentId: "agent_a",
      })
    );
  });

  it("inserts a fresh row when nothing exists for (machine, agent)", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    const r = await q.mintAgentRunnerKey(chain, {
      userId: "u_1",
      machineId: "cm_1",
      agentId: "agent_a",
    });
    expect(r.existed).toBe(false);
    expect(r.runnerKey.startsWith("crk_")).toBe(true);
    // Insert values include runnerKeyHash and doName.
    const inserted = chain.values.mock.calls[0][0];
    expect(inserted.runnerKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted.doName).toBe(inserted.runnerKeyHash.slice(0, 32));
  });
});

describe("findActiveAgentRunnerKeyByBearer", () => {
  it("returns null for a non-`crk_` prefix", async () => {
    const chain: any = {
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
    };
    expect(await q.findActiveAgentRunnerKeyByBearer(chain, "cmk_wrong")).toBeNull();
    expect(chain.select).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// revokeCredentialsForMachine
// ---------------------------------------------------------------------------

describe("revokeCredentialsForMachine", () => {
  it("soft-revokes every active credential and returns the DO-name suffixes", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    let captured: unknown;
    chain.where = vi.fn((w: unknown) => {
      captured = w;
      return chain;
    });
    chain.returning = vi.fn(() =>
      Promise.resolve([{ doName: "aa".repeat(16) }, { doName: "bb".repeat(16) }])
    );
    const result = await q.revokeCredentialsForMachine(chain, "u_1", "cm_1");
    expect(chain.update).toHaveBeenCalledOnce();
    expect(chain.set).toHaveBeenCalledOnce();
    expect(captured).toBeDefined();
    expect(result.doNames).toEqual(["aa".repeat(16), "bb".repeat(16)]);
  });
});
