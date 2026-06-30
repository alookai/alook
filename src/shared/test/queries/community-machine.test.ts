import { describe, it, expect, vi } from "vitest";
import * as q from "../../src/db/queries/community/machine";

describe("community/machine exports", () => {
  it("exports the documented helpers", () => {
    expect(typeof q.createPairingToken).toBe("function");
    expect(typeof q.claimPairingToken).toBe("function");
    expect(typeof q.findActiveToken).toBe("function");
    expect(typeof q.findTokenById).toBe("function");
    expect(typeof q.touchTokenLastUsed).toBe("function");
    expect(typeof q.revokeToken).toBe("function");
    expect(typeof q.upsertMachineForUser).toBe("function");
    expect(typeof q.touchMachineHeartbeat).toBe("function");
    expect(typeof q.getMachineByIdForUser).toBe("function");
    expect(typeof q.listMachinesForUser).toBe("function");
    expect(typeof q.deleteMachineForUser).toBe("function");
    expect(typeof q.toSummary).toBe("function");
    expect(typeof q.computeStatus).toBe("function");
  });
});

describe("machineUuidFromTokenId / tokenIdFromMachineUuid", () => {
  it("derives machine_uuid by swapping cmt_ → cmu_", () => {
    expect(q.machineUuidFromTokenId("cmt_abc123")).toBe("cmu_abc123");
  });
  it("reverses to the original token id", () => {
    expect(q.tokenIdFromMachineUuid("cmu_abc123")).toBe("cmt_abc123");
  });
  it("rejects values without the expected prefix", () => {
    expect(() => q.machineUuidFromTokenId("al_xyz")).toThrow();
    expect(() => q.tokenIdFromMachineUuid("cmt_xyz")).toThrow();
  });
});

describe("computeStatus", () => {
  it("returns offline when lastSeenAt is null", () => {
    expect(q.computeStatus(null)).toBe("offline");
  });
  it("returns online when lastSeenAt is recent", () => {
    expect(q.computeStatus(new Date(Date.now() - 1_000).toISOString())).toBe("online");
  });
  it("returns offline when lastSeenAt is older than the threshold", () => {
    expect(q.computeStatus(new Date(Date.now() - 60_000).toISOString())).toBe("offline");
  });
});

describe("toSummary", () => {
  it("maps a row into the wire shape with derived status", () => {
    const now = new Date().toISOString();
    const row = {
      id: "cm_x",
      userId: "u_1",
      machineUuid: "cmu_xxx",
      displayName: "host",
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      osRelease: "23.6.0",
      daemonVersion: "0.1.0",
      metadata: null,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const s = q.toSummary(row);
    expect(s.id).toBe("cm_x");
    expect(s.hostname).toBe("host");
    expect(s.platform).toBe("darwin");
    expect(s.status).toBe("online");
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

describe("upsertMachineForUser — insert path", () => {
  it("inserts a fresh row and returns null priorLastSeenAt", async () => {
    const inserted = {
      id: "cm_1",
      userId: "u_1",
      machineUuid: "cmu_abc",
      displayName: "myhost",
      hostname: "myhost",
      platform: "darwin",
      arch: "arm64",
      osRelease: "23",
      daemonVersion: "0.1.0",
      metadata: null,
      lastSeenAt: "now",
      createdAt: "now",
      updatedAt: "now",
    };
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([inserted]));
    const { machine, priorLastSeenAt } = await q.upsertMachineForUser(
      chain,
      "u_1",
      "cmt_abc",
      { hostname: "myhost", platform: "darwin", arch: "arm64", daemonVersion: "0.1.0" }
    );
    expect(priorLastSeenAt).toBeNull();
    expect(machine.displayName).toBe("myhost");
  });
});
