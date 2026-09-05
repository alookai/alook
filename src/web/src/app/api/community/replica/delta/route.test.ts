import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireServer: vi.fn(),
  requireChannel: vi.fn(),
  window: vi.fn(),
  messages: vi.fn(),
  enrich: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ kind: "primary" }) }));
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => (req: any) => handler(req, {
    env: { DB: {} },
    actor: { kind: "human", userId: "u1", email: "u@example.com" },
  }),
  rejectBot: () => null,
}));
vi.mock("@/lib/community/permissions", () => ({
  requireServerMember: (...args: unknown[]) => mocks.requireServer(...args),
  requireMessageSurfaceAccess: (...args: unknown[]) => mocks.requireChannel(...args),
}));
vi.mock("@/lib/community/enrich-messages", () => ({
  enrichMessages: (...args: unknown[]) => mocks.enrich(...args),
}));
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityReplicaDelta: {
        readReplicaDeltaWindow: (...args: unknown[]) => mocks.window(...args),
      },
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessagesByIdsInScope: (...args: unknown[]) => mocks.messages(...args),
      },
    },
  };
});

import { POST } from "./route";

const now = "2026-09-06T00:00:00.000Z";
const channel = { kind: "channel" as const, id: "c1" };

function request(frontier: unknown) {
  return new NextRequest("http://localhost/api/community/replica/delta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, frontier, limit: 10 }),
  });
}

describe("POST /api/community/replica/delta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireServer.mockResolvedValue({ ok: true, value: {} });
    mocks.requireChannel.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "c1", serverId: "s1", type: "text" } },
    });
  });

  it("collapses revoked and unknown scopes to permission-changed without reading deltas", async () => {
    mocks.requireChannel.mockResolvedValue({ ok: false, status: 404, error: "not found" });
    const response = await POST(request([{ scope: channel, revision: 2 }]) as any);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      protocolVersion: 1,
      status: "rebootstrap",
      reason: "permission-changed",
      scopes: [channel],
    });
    expect(mocks.window).not.toHaveBeenCalled();
  });

  it("hydrates a descriptor into one strict canonical message delta", async () => {
    mocks.window.mockResolvedValue({
      status: "ok",
      rows: [{
        scopeKind: "channel",
        scopeId: "c1",
        revision: 3,
        causalId: "message:m3",
        committedAt: now,
        descriptor: { kind: "message-upsert", messageId: "m3" },
      }],
      frontier: [{ scope: channel, revision: 3 }],
      hasMore: false,
    });
    mocks.messages.mockResolvedValue([{ id: "m3", replyToId: null }]);
    mocks.enrich.mockResolvedValue({
      latestSeq: 9,
      messages: [{
        id: "m3",
        type: "chat",
        authorId: "u2",
        authorName: "Sam",
        authorAvatar: "S",
        authorAvatarVersion: 0,
        seq: 9,
        createdAt: now,
        content: "hello",
        mentionType: null,
        embeds: null,
      }],
    });
    const response = await POST(request([{ scope: channel, revision: 2 }]) as any);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as any;
    expect(body.status).toBe("ok");
    expect(body.batches[0].deltas[0]).toEqual({
      scope: channel,
      fromRevision: 2,
      toRevision: 3,
      operations: [{
        operation: "upsert",
        entity: { kind: "message", id: "m3" },
        value: expect.objectContaining({ id: "m3", channelId: "c1", seq: 9, createdAt: now }),
      }],
    });
  });

  it("returns a gap when an upsert descriptor no longer hydrates", async () => {
    mocks.window.mockResolvedValue({
      status: "ok",
      rows: [{
        scopeKind: "channel",
        scopeId: "c1",
        revision: 3,
        causalId: "message:m3",
        committedAt: now,
        descriptor: { kind: "message-upsert", messageId: "m3" },
      }],
      frontier: [{ scope: channel, revision: 3 }],
      hasMore: false,
    });
    mocks.messages.mockResolvedValue([]);
    mocks.enrich.mockResolvedValue({ latestSeq: 0, messages: [] });
    const response = await POST(request([{ scope: channel, revision: 2 }]) as any);
    await expect(response.json()).resolves.toEqual({
      protocolVersion: 1,
      status: "rebootstrap",
      reason: "gap",
      scopes: [channel],
    });
  });
});
