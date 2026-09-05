import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  readStable: vi.fn(),
  loadRows: vi.fn(),
  requireServer: vi.fn(),
  requireChannel: vi.fn(),
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
vi.mock("@/lib/community/storage", () => ({
  serverIconUrl: (server: { icon?: string | null }) => server.icon ?? null,
}));
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityReplicaBootstrap: {
        readStableReplicaSnapshot: (...args: unknown[]) => mocks.readStable(...args),
        loadReplicaBootstrapRows: (...args: unknown[]) => mocks.loadRows(...args),
      },
    },
  };
});

import { POST } from "./route";

const now = "2026-09-06T00:00:00.000Z";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/community/replica/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/community/replica/bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireServer.mockResolvedValue({ ok: true, value: { id: "member-1" } });
    mocks.requireChannel.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "c1", serverId: "s1", type: "text" } },
    });
    mocks.loadRows.mockResolvedValue({
      servers: [{
        id: "s1",
        name: "Team",
        discriminator: "0001",
        description: "",
        icon: null,
        ownerId: "u1",
        role: "owner",
        railOrder: 0,
        mentions: 0,
      }],
      mentionSources: [],
      accountUnread: [],
      categories: [{ id: "cat1", serverId: "s1", name: "Public", position: 0, private: 0, creatorId: null }],
      channels: [{ id: "c1", serverId: "s1", categoryId: "cat1", name: "all", position: 0, type: "text", creatorId: null }],
      serverUnread: [],
      readStates: [{ channelId: "c1", lastReadMessageId: "m1", lastReadAt: now, lastReadSeq: 1 }],
      messageTails: [{
        channelId: "c1",
        rows: [{ id: "m1", replyToId: null }],
        hasOlder: false,
      }],
    });
    mocks.enrich.mockResolvedValue({
      latestSeq: 1,
      messages: [{
        id: "m1",
        type: "chat",
        authorId: "u2",
        authorName: "Sam",
        authorAvatar: "S",
        authorAvatarVersion: 0,
        seq: 1,
        createdAt: now,
        content: "hello",
        mentionType: null,
        embeds: null,
      }],
    });
    mocks.readStable.mockImplementation(async (_db, scopes, load) => ({
      frontier: scopes.map((scope: { kind: string; id: string }, index: number) => ({ scope, revision: index + 1 })),
      value: await load(),
    }));
  });

  it("returns one validated no-store snapshot with render-ready concrete facts", async () => {
    const response = await POST(request({
      protocolVersion: 1,
      serverId: "s1",
      tails: [{ channelId: "c1", limit: 50 }],
    }) as any);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as any;
    expect(body.protocolVersion).toBe(1);
    expect(body.frontier).toEqual([
      { scope: { kind: "account", id: "u1" }, revision: 1 },
      { scope: { kind: "server", id: "s1" }, revision: 2 },
      { scope: { kind: "channel", id: "c1" }, revision: 3 },
    ]);
    expect(body.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: { kind: "server", id: "s1" } }),
      expect.objectContaining({ entity: { kind: "category", id: "cat1" } }),
      expect.objectContaining({ entity: { kind: "channel", id: "c1" } }),
      expect.objectContaining({ entity: { kind: "read-state", id: "c1" } }),
      expect.objectContaining({
        scope: { kind: "channel", id: "c1" },
        entity: { kind: "message", id: "m1" },
        value: expect.objectContaining({ channelId: "c1", seq: 1, createdAt: now }),
      }),
    ]));
    const message = body.facts.find((fact: any) => fact.entity.kind === "message").value;
    expect(message).not.toHaveProperty("mentionType");
    expect(message).not.toHaveProperty("embeds");
  });

  it("rechecks authorization inside the stable read and publishes no facts after revocation", async () => {
    mocks.requireServer.mockResolvedValue({ ok: false, status: 403, error: "forbidden" });
    const response = await POST(request({
      protocolVersion: 1,
      serverId: "s1",
      tails: [],
    }) as any);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(mocks.loadRows).not.toHaveBeenCalled();
  });

  it("rejects an unsupported protocol before touching D1", async () => {
    const response = await POST(request({ protocolVersion: 2, serverId: "s1", tails: [] }) as any);
    expect(response.status).toBe(400);
    expect(mocks.readStable).not.toHaveBeenCalled();
  });
});
