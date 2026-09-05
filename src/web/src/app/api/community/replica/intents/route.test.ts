import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  resolveTarget: vi.fn(),
  createMessage: vi.fn(),
  getIntent: vi.fn(),
  rejectIntent: vi.fn(),
  acceptBuilder: vi.fn(),
  getByNonce: vi.fn(),
  getInScope: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ kind: "primary" }) }));
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => (req: any) => handler(req, {
    env: { DB: {} },
    actor: { kind: "human", userId: "u1", email: "u@example.com" },
  }),
  rejectBot: () => null,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mocks.rateLimit(...args),
}));
vi.mock("@/lib/community/message-door", () => ({
  resolveMessageTarget: (...args: unknown[]) => mocks.resolveTarget(...args),
}));
vi.mock("@/lib/community/message-handler", () => ({
  createCommunityMessage: (...args: unknown[]) => mocks.createMessage(...args),
}));
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityReplicaStore: {
        getReplicaIntent: (...args: unknown[]) => mocks.getIntent(...args),
        rejectReplicaTextIntent: (...args: unknown[]) => mocks.rejectIntent(...args),
        acceptReplicaTextIntentBuilder: (...args: unknown[]) => mocks.acceptBuilder(...args),
      },
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessageByAuthorAndNonce: (...args: unknown[]) => mocks.getByNonce(...args),
        getMessageInScope: (...args: unknown[]) => mocks.getInScope(...args),
      },
    },
  };
});

import { POST } from "./route";

const now = "2026-09-06T00:00:00.000Z";
const target = { kind: "channel", channelId: "c1" };
const statement = { kind: "intent-statement" };

function intent(overrides: Record<string, unknown> = {}) {
  return {
    intentId: "intent-1",
    kind: "message.send",
    scope: { kind: "channel", id: "c1" },
    createdAt: now,
    payload: { content: "hello" },
    ...overrides,
  };
}

function request(item = intent()) {
  return new NextRequest("http://localhost/api/community/replica/intents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, intents: [item] }),
  });
}

function acceptedRow(status: "accepted" | "transformed" = "accepted") {
  return {
    actorId: "u1",
    intentId: "intent-1",
    requestHash: "stored-hash",
    status,
    causalId: "message:m1",
    channelId: "c1",
    messageId: "m1",
    revision: 4,
    seq: 9,
    reason: status === "transformed" ? "reply target was unavailable; sent as a plain message" : null,
    rejectionCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("POST /api/community/replica/intents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.resolveTarget.mockResolvedValue({ ok: true, value: { target, isDm: false } });
    mocks.getByNonce.mockResolvedValue(null);
    mocks.getInScope.mockResolvedValue({ id: "reply-1" });
    mocks.acceptBuilder.mockReturnValue(statement);
    mocks.createMessage.mockResolvedValue({ ok: true });
  });

  it("atomically attaches an accepted outcome to the canonical message write", async () => {
    mocks.getIntent.mockResolvedValueOnce(null).mockImplementation(async () => {
      const builderInput = mocks.acceptBuilder.mock.calls[0]?.[1];
      return { ...acceptedRow(), requestHash: builderInput.requestHash };
    });

    const response = await POST(request() as any);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.acceptBuilder).toHaveBeenCalledWith(
      { kind: "primary" },
      expect.objectContaining({
        actorId: "u1",
        intentId: "intent-1",
        channelId: "c1",
        status: "accepted",
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      authorId: "u1",
      target,
      body: { content: "hello" },
      clientNonce: "intent-1",
      extraStatements: [statement],
    }));
    await expect(response.json()).resolves.toEqual({
      protocolVersion: 1,
      outcomes: [{
        intentId: "intent-1",
        status: "accepted",
        causalId: "message:m1",
        canonical: {
          scope: { kind: "channel", id: "c1" },
          revision: 4,
          messageId: "m1",
          seq: 9,
        },
      }],
    });
  });

  it("records a transformed outcome when a stale reply target becomes a plain send", async () => {
    mocks.getInScope.mockResolvedValue(null);
    mocks.getIntent.mockResolvedValueOnce(null).mockImplementation(async () => {
      const builderInput = mocks.acceptBuilder.mock.calls[0]?.[1];
      return { ...acceptedRow("transformed"), requestHash: builderInput.requestHash };
    });

    const response = await POST(request(intent({ payload: { content: "hello", replyToId: "gone" } })) as any);

    expect(mocks.acceptBuilder).toHaveBeenCalledWith(
      { kind: "primary" },
      expect.objectContaining({
        status: "transformed",
        reason: "reply target was unavailable; sent as a plain message",
      }),
    );
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({ body: { content: "hello" } }));
    const body = await response.json() as any;
    expect(body.outcomes[0]).toMatchObject({
      status: "transformed",
      reason: "reply target was unavailable; sent as a plain message",
    });
  });

  it("treats an intentId reused for different bytes as a terminal conflict", async () => {
    mocks.getIntent.mockResolvedValue({ ...acceptedRow(), requestHash: "different-hash" });

    const response = await POST(request() as any);

    await expect(response.json()).resolves.toEqual({
      protocolVersion: 1,
      outcomes: [{
        intentId: "intent-1",
        status: "rejected",
        code: "conflict",
        reason: "intentId was already used for a different request",
      }],
    });
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it("returns retryable transport backpressure without inventing terminal outcomes", async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, retryAfterSec: 7 });

    const response = await POST(request() as any);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    await expect(response.json()).resolves.toEqual({ error: "rate limited" });
    expect(mocks.getIntent).not.toHaveBeenCalled();
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });
});
