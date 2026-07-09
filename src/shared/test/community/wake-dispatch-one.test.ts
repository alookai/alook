import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetWakeMessageScopeById = vi.fn();
vi.mock("../../src/db/queries/community/message", () => ({
  getWakeMessageScopeById: (...a: unknown[]) => mockGetWakeMessageScopeById(...a),
}));

const mockGetBotWakeContext = vi.fn();
vi.mock("../../src/db/queries/community/bot", () => ({
  getBotWakeContext: (...a: unknown[]) => mockGetBotWakeContext(...a),
}));

const mockCanBotReadWakeScope = vi.fn();
vi.mock("../../src/db/queries/community/member", () => ({
  canBotReadWakeScope: (...a: unknown[]) => mockCanBotReadWakeScope(...a),
}));

const mockGetWakeReadSeq = vi.fn();
vi.mock("../../src/db/queries/community/read-state", () => ({
  getWakeReadSeq: (...a: unknown[]) => mockGetWakeReadSeq(...a),
}));

const mockResolveUnreadNoticeChannel = vi.fn();
vi.mock("../../src/db/queries/community/agent-inbox", () => ({
  resolveUnreadNoticeChannel: (...a: unknown[]) => mockResolveUnreadNoticeChannel(...a),
}));

import { dispatchOneUnreadWake } from "../../src/community/wake-dispatch";
import type { Database } from "../../src/db/index";

const fakeDb = {} as Database;

const MESSAGE_CHANNEL = {
  id: "msg_1",
  seq: 7,
  authorId: "u_human",
  channelId: "ch_1",
  dmConversationId: null,
};

const BOT_READY = {
  state: "ready" as const,
  botUserId: "bot_1",
  name: "zoe",
  discriminator: "0042",
  machineId: "machine_1",
  runtime: "claude",
};

function seedReady() {
  mockGetWakeMessageScopeById.mockResolvedValue(MESSAGE_CHANNEL);
  mockGetBotWakeContext.mockResolvedValue(BOT_READY);
  mockCanBotReadWakeScope.mockResolvedValue(true);
  mockGetWakeReadSeq.mockResolvedValue(0);
  mockResolveUnreadNoticeChannel.mockResolvedValue("/srv_1/general");
}

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return { WS_DO_WORKER: { fetch: vi.fn(fetchImpl) } as unknown as Fetcher };
}

/**
 * `dispatchOneUnreadWake` is the ONE per-candidate function both
 * `src/wake-worker`'s real queue consumer and `src/web`'s dev-only inline
 * stand-in call — these tests exercise it through its real
 * `buildUnreadWakeCommand`/`sendWakeToMachine` wiring end-to-end (query
 * modules mocked, `fetch` mocked), so neither caller needs its own
 * "what does a wake candidate resolve to" test coverage.
 */
describe("dispatchOneUnreadWake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves to { outcome: 'sent' } when the rebuild is ready and the daemon is online", async () => {
    seedReady();
    const env = makeEnv(async () => new Response(JSON.stringify({ sent: 1 }), { status: 200 }));

    const result = await dispatchOneUnreadWake(fakeDb, env, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ outcome: "sent" });
  });

  it("resolves to { outcome: 'delivered_nowhere', machineId } when the daemon is offline", async () => {
    seedReady();
    const env = makeEnv(async () => new Response(JSON.stringify({ sent: 0 }), { status: 200 }));

    const result = await dispatchOneUnreadWake(fakeDb, env, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ outcome: "delivered_nowhere", machineId: "machine_1" });
  });

  it("resolves to { outcome: 'skip', reason } without ever calling fetch when the rebuild is a skip", async () => {
    mockGetWakeMessageScopeById.mockResolvedValue(null);
    const fetchMock = vi.fn();
    const env = makeEnv(fetchMock);

    const result = await dispatchOneUnreadWake(fakeDb, env, { messageId: "msg_gone", botUserId: "bot_1" });

    expect(result).toEqual({ outcome: "skip", reason: "message_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a throw from buildUnreadWakeCommand (caller decides retry vs log)", async () => {
    mockGetWakeMessageScopeById.mockRejectedValue(new Error("D1_ERROR: query failed"));
    const env = makeEnv(async () => new Response("{}", { status: 200 }));

    await expect(
      dispatchOneUnreadWake(fakeDb, env, { messageId: "msg_1", botUserId: "bot_1" }),
    ).rejects.toThrow("D1_ERROR");
  });

  it("propagates a throw from sendWakeToMachine (transient ws-do failure)", async () => {
    seedReady();
    const env = makeEnv(async () => new Response("boom", { status: 500 }));

    await expect(
      dispatchOneUnreadWake(fakeDb, env, { messageId: "msg_1", botUserId: "bot_1" }),
    ).rejects.toThrow();
  });
});
