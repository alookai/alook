import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseReplicaDeltaDescriptor } from "../../src/db/queries/community/replica-store";

const mocks = vi.hoisted(() => ({
  revisions: vi.fn(),
  rows: vi.fn(),
}));

vi.mock("../../src/db/queries/community/replica-store", async () => {
  const actual = await vi.importActual<typeof import("../../src/db/queries/community/replica-store")>(
    "../../src/db/queries/community/replica-store",
  );
  return {
    ...actual,
    getReplicaScopeRevisions: (...args: unknown[]) => mocks.revisions(...args),
    listReplicaDeltaRows: (...args: unknown[]) => mocks.rows(...args),
  };
});

import { readStableReplicaSnapshot } from "../../src/db/queries/community/replica-bootstrap";
import { readReplicaDeltaWindow } from "../../src/db/queries/community/replica-delta";

const channel = { kind: "channel" as const, id: "c1" };
const account = { kind: "account" as const, id: "u1" };

describe("Replica storage descriptors", () => {
  it("accepts only the two closed message descriptor shapes", () => {
    expect(parseReplicaDeltaDescriptor('{"kind":"message-upsert","messageId":"m1"}')).toEqual({
      kind: "message-upsert",
      messageId: "m1",
    });
    expect(() => parseReplicaDeltaDescriptor('{"kind":"raw-row","messageId":"m1"}')).toThrow(
      "invalid Replica delta descriptor",
    );
    expect(() => parseReplicaDeltaDescriptor("null")).toThrow("invalid Replica delta descriptor");
  });
});

describe("readStableReplicaSnapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries a raced read and publishes only a matching frontier", async () => {
    mocks.revisions
      .mockResolvedValueOnce([{ scope: channel, revision: 1 }])
      .mockResolvedValueOnce([{ scope: channel, revision: 2 }])
      .mockResolvedValueOnce([{ scope: channel, revision: 2 }])
      .mockResolvedValueOnce([{ scope: channel, revision: 2 }]);
    const load = vi.fn().mockResolvedValueOnce("raced").mockResolvedValueOnce("stable");
    await expect(readStableReplicaSnapshot({} as any, [channel], load)).resolves.toEqual({
      frontier: [{ scope: channel, revision: 2 }],
      value: "stable",
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("fails closed when every snapshot attempt races", async () => {
    mocks.revisions
      .mockResolvedValueOnce([{ scope: channel, revision: 1 }])
      .mockResolvedValueOnce([{ scope: channel, revision: 2 }])
      .mockResolvedValueOnce([{ scope: channel, revision: 2 }])
      .mockResolvedValueOnce([{ scope: channel, revision: 3 }]);
    await expect(readStableReplicaSnapshot({} as any, [channel], async () => "value", 2))
      .rejects.toThrow("Replica snapshot changed");
  });
});

describe("readReplicaDeltaWindow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires rebootstrap for changed non-channel scopes", async () => {
    mocks.revisions.mockResolvedValue([{ scope: account, revision: 4 }]);
    await expect(readReplicaDeltaWindow(
      {} as any,
      [{ scope: account, revision: 3 }],
      10,
    )).resolves.toEqual({ status: "rebootstrap", scopes: [account] });
    expect(mocks.rows).not.toHaveBeenCalled();
  });

  it("returns a contiguous channel prefix and an exact resulting frontier", async () => {
    mocks.revisions.mockResolvedValue([{ scope: channel, revision: 4 }]);
    mocks.rows.mockResolvedValue([
      { scopeKind: "channel", scopeId: "c1", revision: 3, causalId: "m3", committedAt: "t3", descriptor: { kind: "message-upsert", messageId: "m3" } },
      { scopeKind: "channel", scopeId: "c1", revision: 4, causalId: "m4", committedAt: "t4", descriptor: { kind: "message-upsert", messageId: "m4" } },
    ]);
    await expect(readReplicaDeltaWindow(
      {} as any,
      [{ scope: channel, revision: 2 }],
      1,
    )).resolves.toEqual({
      status: "ok",
      rows: [expect.objectContaining({ revision: 3 })],
      frontier: [{ scope: channel, revision: 3 }],
      hasMore: true,
    });
  });

  it("turns a missing revision into rebootstrap instead of an empty success", async () => {
    mocks.revisions.mockResolvedValue([{ scope: channel, revision: 4 }]);
    mocks.rows.mockResolvedValue([
      { scopeKind: "channel", scopeId: "c1", revision: 4, causalId: "m4", committedAt: "t4", descriptor: { kind: "message-upsert", messageId: "m4" } },
    ]);
    await expect(readReplicaDeltaWindow(
      {} as any,
      [{ scope: channel, revision: 2 }],
      10,
    )).resolves.toEqual({ status: "rebootstrap", scopes: [channel] });
  });
});
