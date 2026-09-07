import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireServer: vi.fn(),
  requireChannel: vi.fn(),
  window: vi.fn(),
  messages: vi.fn(),
  enrich: vi.fn(),
  accountServers: vi.fn(),
  readStates: vi.fn(),
  categories: vi.fn(),
  categoryChannelIds: vi.fn(),
  channels: vi.fn(),
  unreadSources: vi.fn(),
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
        loadReplicaAccountServers: (...args: unknown[]) => mocks.accountServers(...args),
        loadReplicaReadStates: (...args: unknown[]) => mocks.readStates(...args),
        loadReplicaCategories: (...args: unknown[]) => mocks.categories(...args),
        listReplicaCategoryChannelIds: (...args: unknown[]) => mocks.categoryChannelIds(...args),
        loadReplicaChannels: (...args: unknown[]) => mocks.channels(...args),
        loadReplicaUnreadSources: (...args: unknown[]) => mocks.unreadSources(...args),
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
    mocks.accountServers.mockResolvedValue([]);
    mocks.readStates.mockResolvedValue([]);
    mocks.categories.mockResolvedValue([]);
    mocks.categoryChannelIds.mockResolvedValue([]);
    mocks.channels.mockResolvedValue([]);
    mocks.unreadSources.mockResolvedValue([]);
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

  it("checks server membership before reading or hydrating a server delta", async () => {
    const server = { kind: "server" as const, id: "s1" };
    mocks.requireServer.mockResolvedValue({ ok: false, status: 404, error: "not found" });
    const response = await POST(request([{ scope: server, revision: 2 }]) as any);
    await expect(response.json()).resolves.toEqual({
      protocolVersion: 1,
      status: "rebootstrap",
      reason: "permission-changed",
      scopes: [server],
    });
    expect(mocks.window).not.toHaveBeenCalled();
    expect(mocks.channels).not.toHaveBeenCalled();
    expect(mocks.unreadSources).not.toHaveBeenCalled();
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

  it("hydrates account read-state and server-summary descriptors without a snapshot", async () => {
    const account = { kind: "account" as const, id: "u1" };
    mocks.window.mockResolvedValue({
      status: "ok",
      rows: [{
        scopeKind: "account",
        scopeId: "u1",
        revision: 5,
        causalId: "read-state:r1:5",
        committedAt: now,
        descriptor: { kind: "read-state-refresh", channelId: "c1", serverId: "s1" },
      }],
      frontier: [{ scope: account, revision: 5 }],
      hasMore: false,
    });
    mocks.readStates.mockResolvedValue([{
      channelId: "c1",
      lastReadMessageId: "m4",
      lastReadAt: now,
      lastReadSeq: 4,
    }]);
    mocks.accountServers.mockResolvedValue([{
      id: "s1",
      name: "Replica",
      discriminator: "1000",
      description: null,
      icon: null,
      ownerId: "u1",
      role: "owner",
      railOrder: 0,
      joinedAt: now,
      unreadSources: [],
      mentionSources: [],
      mentions: 0,
    }]);

    const response = await POST(request([{ scope: account, revision: 4 }]) as any);
    const body = await response.json() as any;
    expect(body.status).toBe("ok");
    expect(body.batches[0].deltas[0].operations).toEqual([
      expect.objectContaining({
        operation: "upsert",
        entity: { kind: "read-state", id: "c1" },
        value: expect.objectContaining({ lastReadMessageId: "m4", lastReadSeq: 4 }),
      }),
      expect.objectContaining({
        operation: "upsert",
        entity: { kind: "server", id: "s1" },
        value: expect.objectContaining({ id: "s1", unread: false, mentions: 0 }),
      }),
    ]);
    expect(mocks.accountServers).toHaveBeenCalledWith(expect.anything(), "u1", ["s1"]);
    expect(mocks.readStates).toHaveBeenCalledWith(expect.anything(), "u1", ["c1"]);
  });

  it("turns an inaccessible channel refresh into explicit channel and unread removals", async () => {
    const server = { kind: "server" as const, id: "s1" };
    mocks.window.mockResolvedValue({
      status: "ok",
      rows: [{
        scopeKind: "server",
        scopeId: "s1",
        revision: 3,
        causalId: "channel-member:cm1",
        committedAt: now,
        descriptor: { kind: "channel-refresh", channelId: "private-c" },
      }],
      frontier: [{ scope: server, revision: 3 }],
      hasMore: false,
    });

    const response = await POST(request([{ scope: server, revision: 2 }]) as any);
    const body = await response.json() as any;
    expect(body.batches[0].deltas[0].operations).toEqual([
      { operation: "remove", entity: { kind: "channel", id: "private-c" } },
      { operation: "remove", entity: { kind: "unread-source", id: "private-c" } },
    ]);
    expect(mocks.channels).toHaveBeenCalledWith(expect.anything(), "u1", "s1", ["private-c"]);
    expect(mocks.unreadSources).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      "s1",
      ["private-c"],
    );
  });

  it("removes an unread source when a refreshed child thread is inaccessible or deleted", async () => {
    const server = { kind: "server" as const, id: "s1" };
    mocks.window.mockResolvedValue({
      status: "ok",
      rows: [{
        scopeKind: "server",
        scopeId: "s1",
        revision: 4,
        causalId: "channel-member:cm-child",
        committedAt: now,
        descriptor: { kind: "unread-source-refresh", channelId: "private-thread" },
      }],
      frontier: [{ scope: server, revision: 4 }],
      hasMore: false,
    });

    const response = await POST(request([{ scope: server, revision: 3 }]) as any);
    const body = await response.json() as any;
    expect(body.batches[0].deltas[0].operations).toEqual([
      { operation: "remove", entity: { kind: "unread-source", id: "private-thread" } },
    ]);
    expect(mocks.unreadSources).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      "s1",
      ["private-thread"],
    );
  });

  it("reconciles every category channel when category privacy changes", async () => {
    const server = { kind: "server" as const, id: "s1" };
    mocks.window.mockResolvedValue({
      status: "ok",
      rows: [{
        scopeKind: "server",
        scopeId: "s1",
        revision: 8,
        causalId: "category-update:cat1:8",
        committedAt: now,
        descriptor: { kind: "category-refresh", categoryId: "cat1", reconcileChannels: true },
      }],
      frontier: [{ scope: server, revision: 8 }],
      hasMore: false,
    });
    mocks.categories.mockResolvedValue([{
      id: "cat1",
      serverId: "s1",
      name: "Private",
      position: 1,
      private: 1,
      creatorId: "u1",
    }]);
    mocks.categoryChannelIds.mockResolvedValue([
      { categoryId: "cat1", channelId: "visible-c" },
      { categoryId: "cat1", channelId: "hidden-c" },
    ]);
    mocks.channels.mockResolvedValue([{
      id: "visible-c",
      serverId: "s1",
      categoryId: "cat1",
      name: "Visible",
      position: 0,
      createdAt: now,
      type: "text",
      creatorId: null,
    }]);
    mocks.unreadSources.mockResolvedValue([{ channelId: "visible-c", value: null }]);

    const response = await POST(request([{ scope: server, revision: 7 }]) as any);
    const body = await response.json() as any;
    expect(body.batches[0].deltas[0].operations).toEqual([
      expect.objectContaining({ operation: "upsert", entity: { kind: "category", id: "cat1" } }),
      expect.objectContaining({ operation: "upsert", entity: { kind: "channel", id: "visible-c" } }),
      { operation: "remove", entity: { kind: "unread-source", id: "visible-c" } },
      { operation: "remove", entity: { kind: "channel", id: "hidden-c" } },
      { operation: "remove", entity: { kind: "unread-source", id: "hidden-c" } },
    ]);
  });

  it("rebootstraps honestly when one privacy reconciliation exceeds the operation bound", async () => {
    const server = { kind: "server" as const, id: "s1" };
    const channelIds = Array.from({ length: 128 }, (_, index) => `c-${index}`);
    mocks.window.mockResolvedValue({
      status: "ok",
      rows: [{
        scopeKind: "server",
        scopeId: "s1",
        revision: 9,
        causalId: "category-update:cat1:9",
        committedAt: now,
        descriptor: { kind: "category-refresh", categoryId: "cat1", reconcileChannels: true },
      }],
      frontier: [{ scope: server, revision: 9 }],
      hasMore: false,
    });
    mocks.categories.mockResolvedValue([{
      id: "cat1",
      serverId: "s1",
      name: "Private",
      position: 1,
      private: 1,
      creatorId: "u1",
    }]);
    mocks.categoryChannelIds.mockResolvedValue(channelIds.map((channelId) => ({
      categoryId: "cat1",
      channelId,
    })));

    const response = await POST(request([{ scope: server, revision: 8 }]) as any);
    await expect(response.json()).resolves.toEqual({
      protocolVersion: 1,
      status: "rebootstrap",
      reason: "gap",
      scopes: [server],
    });
  });
});
