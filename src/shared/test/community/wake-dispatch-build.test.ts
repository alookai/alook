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

import { buildUnreadWakeCommand } from "../../src/community/wake-dispatch";
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

function seedHappyPath(overrides?: {
  message?: Partial<typeof MESSAGE_CHANNEL>;
  bot?: Partial<typeof BOT_READY>;
  canRead?: boolean;
  readSeq?: number;
  channel?: string | null;
}) {
  mockGetWakeMessageScopeById.mockResolvedValue({ ...MESSAGE_CHANNEL, ...overrides?.message });
  mockGetBotWakeContext.mockResolvedValue({ ...BOT_READY, ...overrides?.bot });
  mockCanBotReadWakeScope.mockResolvedValue(overrides?.canRead ?? true);
  mockGetWakeReadSeq.mockResolvedValue(overrides?.readSeq ?? 0);
  mockResolveUnreadNoticeChannel.mockResolvedValue(
    overrides?.channel === undefined ? "/srv_1/general" : overrides.channel,
  );
}

describe("buildUnreadWakeCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ready: builds an agent:wake HostCommand from current D1 state for a channel message", async () => {
    seedHappyPath();

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected ready");
    expect(result.machineId).toBe("machine_1");
    expect(result.command).toMatchObject({
      type: "agent:wake",
      agentId: "bot_1",
      unreadNotice: { kind: "unread_notice", channel: "/srv_1/general", latestSeq: 7 },
    });
    expect(typeof result.command.launchId).toBe("string");
    expect(result.command.launchId.length).toBeGreaterThan(0);
    expect(result.command).toMatchObject({ config: { runtime: "claude", agentHandle: "@zoe#0042" } });

    // Every downstream query is scoped with the SAME messageId/botUserId/scope.
    expect(mockGetWakeMessageScopeById).toHaveBeenCalledWith(fakeDb, "msg_1");
    expect(mockGetBotWakeContext).toHaveBeenCalledWith(fakeDb, "bot_1");
    expect(mockCanBotReadWakeScope).toHaveBeenCalledWith(fakeDb, "bot_1", { channelId: "ch_1" });
    expect(mockGetWakeReadSeq).toHaveBeenCalledWith(fakeDb, "bot_1", { channelId: "ch_1" });
    expect(mockResolveUnreadNoticeChannel).toHaveBeenCalledWith(fakeDb, { channelId: "ch_1" }, "bot_1");
  });

  it("ready: resolves a DM scope when the message has no channelId", async () => {
    // "/.dm/@gustavo" was never actually valid production output — prod never
    // puts "@" in a ref segment. `resolveUnreadNoticeChannel` now produces a
    // bare `name#0042` handle segment (mocked here, but shaped like the real
    // thing) since DM refs address peers by handle, not raw user id.
    seedHappyPath({
      message: { channelId: null, dmConversationId: "dm_1" },
      channel: "/.dm/gustavo#0042",
    });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected ready");
    expect(result.command.unreadNotice).toEqual({
      kind: "unread_notice",
      channel: "/.dm/gustavo#0042",
      latestSeq: 7,
    });
    expect(mockCanBotReadWakeScope).toHaveBeenCalledWith(fakeDb, "bot_1", { dmConversationId: "dm_1" });
    expect(mockResolveUnreadNoticeChannel).toHaveBeenCalledWith(fakeDb, { dmConversationId: "dm_1" }, "bot_1");
  });

  it("ready: resolves a thread scope (channelId still set — thread channels ARE channels)", async () => {
    seedHappyPath({ channel: "/srv_1/general/#3" });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected ready");
    expect(result.command.unreadNotice.channel).toBe("/srv_1/general/#3");
  });

  it("skip: message_missing when the message no longer exists", async () => {
    mockGetWakeMessageScopeById.mockResolvedValue(null);

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_gone", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "message_missing" });
    expect(mockGetBotWakeContext).not.toHaveBeenCalled();
  });

  it("skip: invalid_message_scope when the message has neither channelId nor dmConversationId", async () => {
    mockGetWakeMessageScopeById.mockResolvedValue({ ...MESSAGE_CHANNEL, channelId: null, dmConversationId: null });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "invalid_message_scope" });
  });

  it("skip: self_authored when the message's author is the same bot (malformed/internal queue item)", async () => {
    mockGetWakeMessageScopeById.mockResolvedValue({ ...MESSAGE_CHANNEL, authorId: "bot_1" });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "self_authored" });
    expect(mockGetBotWakeContext).not.toHaveBeenCalled();
  });

  it("skip: bot_missing when the bot user row is gone/never existed", async () => {
    mockGetWakeMessageScopeById.mockResolvedValue(MESSAGE_CHANNEL);
    mockGetBotWakeContext.mockResolvedValue({ state: "bot_missing" });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "bot_missing" });
    expect(mockCanBotReadWakeScope).not.toHaveBeenCalled();
  });

  it("skip: bot_deleted when the bot user row is soft-deleted", async () => {
    mockGetWakeMessageScopeById.mockResolvedValue(MESSAGE_CHANNEL);
    mockGetBotWakeContext.mockResolvedValue({ state: "bot_deleted" });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "bot_deleted" });
  });

  it("skip: bot_unbound when the bot has no current machine binding — always re-reads the CURRENT binding, not a stale one", async () => {
    mockGetWakeMessageScopeById.mockResolvedValue(MESSAGE_CHANNEL);
    mockGetBotWakeContext.mockResolvedValue({ state: "bot_unbound" });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "bot_unbound" });
  });

  it("skip: bot_not_in_scope when the bot lost membership/participant access before the queue drained", async () => {
    seedHappyPath({ canRead: false });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "bot_not_in_scope" });
    expect(mockGetWakeReadSeq).not.toHaveBeenCalled();
  });

  it("skip: already_read when lastReadSeq >= message.seq (an earlier inboxPull already caught the bot up)", async () => {
    seedHappyPath({ readSeq: 7 });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "already_read" });
    expect(mockResolveUnreadNoticeChannel).not.toHaveBeenCalled();
  });

  it("skip: already_read also fires when lastReadSeq is strictly greater (batched catch-up past this seq)", async () => {
    seedHappyPath({ readSeq: 9 });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "already_read" });
  });

  it("skip: notice_channel_unresolvable when the scope can't be strictly resolved to a ChannelRef (never falls back to /unknown/...)", async () => {
    seedHappyPath({ channel: null });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "notice_channel_unresolvable" });
  });

  it("propagates a D1/query throw from the message lookup instead of returning a skip (caller must retry())", async () => {
    mockGetWakeMessageScopeById.mockRejectedValue(new Error("D1_ERROR: query failed"));

    await expect(
      buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" }),
    ).rejects.toThrow("D1_ERROR");
  });

  it("propagates a D1/query throw from any downstream lookup (bot context, membership, read-state, channel resolution)", async () => {
    mockGetWakeMessageScopeById.mockResolvedValue(MESSAGE_CHANNEL);
    mockGetBotWakeContext.mockRejectedValue(new Error("D1_ERROR: bot lookup failed"));

    await expect(
      buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" }),
    ).rejects.toThrow("D1_ERROR");
  });
});
