import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetWakeMessageScopeById = vi.fn();
vi.mock("../../src/db/queries/community/message", () => ({
  getWakeMessageScopeById: (...a: unknown[]) => mockGetWakeMessageScopeById(...a),
}));

const mockGetBotWakeContext = vi.fn();
const mockBumpBotDailyActivityStatement = vi.fn(() => ({ __stmt: "bump" }));
vi.mock("../../src/db/queries/community/bot", () => ({
  getBotWakeContext: (...a: unknown[]) => mockGetBotWakeContext(...a),
  bumpBotDailyActivityStatement: (...a: unknown[]) => mockBumpBotDailyActivityStatement(...a),
}));

const mockHasMentionForMessage = vi.fn();
vi.mock("../../src/db/queries/community/mention", () => ({
  hasMentionForMessage: (...a: unknown[]) => mockHasMentionForMessage(...a),
}));

const mockInsertBotAuditWakeTrigger = vi.fn();
vi.mock("../../src/db/queries/community/bot-audit-log", () => ({
  insertBotAuditWakeTrigger: (...a: unknown[]) => mockInsertBotAuditWakeTrigger(...a),
}));

const mockGetUsersByIds = vi.fn();
vi.mock("../../src/db/queries/user", () => ({
  getUsersByIds: (...a: unknown[]) => mockGetUsersByIds(...a),
}));

const mockCanBotReadWakeScope = vi.fn();
vi.mock("../../src/db/queries/community/member", () => ({
  canBotReadWakeScope: (...a: unknown[]) => mockCanBotReadWakeScope(...a),
}));

const mockResolveUnreadNoticeChannel = vi.fn();
vi.mock("../../src/db/queries/community/agent-inbox", () => ({
  resolveUnreadNoticeChannel: (...a: unknown[]) => mockResolveUnreadNoticeChannel(...a),
}));

const mockResolveNotificationEligibilityForUsers = vi.fn();
vi.mock("../../src/db/queries/community/notification-eligibility", () => ({
  resolveNotificationEligibilityForUsers: (...a: unknown[]) =>
    mockResolveNotificationEligibilityForUsers(...a),
}));

import { buildUnreadWakeCommand } from "../../src/community/wake-dispatch";
import type { Database } from "../../src/db/index";

const fakeDb = {} as Database;

const MESSAGE_CHANNEL = {
  id: "msg_1",
  seq: 7,
  authorId: "u_human",
  channelId: "ch_1",
};

const BOT_READY: {
  state: "ready";
  botUserId: string;
  name: string;
  discriminator: string;
  machineId: string;
  runtime: string;
  modelName: string | null;
  ownerUserId: string | null;
} = {
  state: "ready",
  botUserId: "bot_1",
  name: "zoe",
  discriminator: "0042",
  machineId: "machine_1",
  runtime: "claude",
  modelName: null,
  ownerUserId: "owner_1",
};

function seedHappyPath(overrides?: {
  message?: Partial<typeof MESSAGE_CHANNEL>;
  bot?: Partial<typeof BOT_READY>;
  canRead?: boolean;
  isUnread?: boolean;
  channel?: string | null;
}) {
  mockGetWakeMessageScopeById.mockResolvedValue({ ...MESSAGE_CHANNEL, ...overrides?.message });
  mockGetBotWakeContext.mockResolvedValue({ ...BOT_READY, ...overrides?.bot });
  mockCanBotReadWakeScope.mockResolvedValue(overrides?.canRead ?? true);
  mockResolveUnreadNoticeChannel.mockResolvedValue(
    overrides?.channel === undefined ? "/srv_1/general" : overrides.channel,
  );
  mockResolveNotificationEligibilityForUsers.mockResolvedValue(new Map([["bot_1", {
    currentLevel: "all",
    hasAttention: false,
    isUnread: overrides?.isUnread ?? true,
    isReadable: true,
  }]]));
  // Audit path best-effort defaults — happy replies so the wake still fires.
  mockGetUsersByIds.mockResolvedValue([{ id: "u_human", name: "gustavo", discriminator: "0042" }]);
  mockHasMentionForMessage.mockResolvedValue(false);
  mockInsertBotAuditWakeTrigger.mockResolvedValue({ id: "evt_1", createdAt: "2026-07-23T00:00:00.000Z" });
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
    if (result.command.type !== "agent:wake") throw new Error("expected agent:wake");
    expect(typeof result.command.launchId).toBe("string");
    expect(result.command.launchId.length).toBeGreaterThan(0);
    expect(result.command).toMatchObject({ config: { runtime: "claude", agentHandle: "@zoe#0042" } });

    // Every downstream query is scoped with the SAME messageId/botUserId/scope.
    expect(mockGetWakeMessageScopeById).toHaveBeenCalledWith(fakeDb, "msg_1");
    expect(mockGetBotWakeContext).toHaveBeenCalledWith(fakeDb, "bot_1");
    expect(mockCanBotReadWakeScope).toHaveBeenCalledWith(fakeDb, "bot_1", { channelId: "ch_1" });
    expect(mockResolveNotificationEligibilityForUsers).toHaveBeenCalledWith(
      fakeDb,
      ["bot_1"],
      "msg_1",
    );
    expect(mockResolveUnreadNoticeChannel).toHaveBeenCalledWith(fakeDb, { channelId: "ch_1" }, "bot_1");
  });

  it("reuses one launchId across queue retry, reconnect resync, and duplicate concurrent rebuilds", async () => {
    seedHappyPath();

    const initial = await buildUnreadWakeCommand(fakeDb, {
      messageId: "msg_1",
      botUserId: "bot_1",
    });
    const queueRetry = await buildUnreadWakeCommand(fakeDb, {
      messageId: "msg_1",
      botUserId: "bot_1",
    });
    const [reconnectResync, duplicate] = await Promise.all([
      buildUnreadWakeCommand(fakeDb, {
        messageId: "msg_1",
        botUserId: "bot_1",
      }),
      buildUnreadWakeCommand(fakeDb, {
        messageId: "msg_1",
        botUserId: "bot_1",
      }),
    ]);

    if (
      initial.state !== "ready" ||
      queueRetry.state !== "ready" ||
      reconnectResync.state !== "ready" ||
      duplicate.state !== "ready"
    ) {
      throw new Error("expected ready wakes");
    }
    expect(initial.command.launchId).toBe(
      "wake_59f46f28b814c6f6b597cc0db2a5c9166d2fee5d3148a3e536a629cc227a8531",
    );
    expect(initial.command.launchId).not.toContain("bot_1");
    expect(initial.command.launchId).not.toContain("msg_1");
    expect(queueRetry.command.launchId).toBe(initial.command.launchId);
    expect(reconnectResync.command.launchId).toBe(initial.command.launchId);
    expect(duplicate.command.launchId).toBe(initial.command.launchId);
    expect(
      mockInsertBotAuditWakeTrigger.mock.calls
        .slice(0, 4)
        .map(([, audit]) => audit.launchId),
    ).toEqual(Array(4).fill(initial.command.launchId));

    seedHappyPath({ message: { id: "msg_2" } });
    const nextMessage = await buildUnreadWakeCommand(fakeDb, {
      messageId: "msg_2",
      botUserId: "bot_1",
    });
    if (nextMessage.state !== "ready") throw new Error("expected ready wake");
    expect(nextMessage.command.launchId).not.toBe(initial.command.launchId);
  });

  it("ready: resolves a DM scope — a DM is a type=dm channel, so it carries a channelId like any other", async () => {
    seedHappyPath({
      message: { channelId: "dm_ch_1" },
      channel: "/.dm/gustavo#0042",
    });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected ready");
    if (result.command.type !== "agent:wake") throw new Error("expected agent:wake");
    expect(result.command.unreadNotice).toEqual({
      kind: "unread_notice",
      channel: "/.dm/gustavo#0042",
      latestSeq: 7,
      channelId: "dm_ch_1",
    });
    expect(mockCanBotReadWakeScope).toHaveBeenCalledWith(fakeDb, "bot_1", { channelId: "dm_ch_1" });
    expect(mockResolveUnreadNoticeChannel).toHaveBeenCalledWith(fakeDb, { channelId: "dm_ch_1" }, "bot_1");
  });

  it("ready: resolves a thread scope (channelId still set — thread channels ARE channels)", async () => {
    seedHappyPath({ channel: "/srv_1/general/#3" });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected ready");
    if (result.command.type !== "agent:wake") throw new Error("expected agent:wake");
    expect(result.command.unreadNotice.channel).toBe("/srv_1/general/#3");
  });

  it("ready: config.model reflects the binding's model_name (named / custom / default)", async () => {
    // Catalog id ⇒ named.
    seedHappyPath({ bot: { modelName: "claude-opus-4-6" } });
    let result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });
    if (result.state !== "ready" || result.command.type !== "agent:wake") throw new Error("expected ready wake");
    expect(result.command.config.model).toEqual({ kind: "named", name: "claude-opus-4-6" });

    // Non-catalog id ⇒ custom.
    seedHappyPath({ bot: { modelName: "my-ft-model" } });
    result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });
    if (result.state !== "ready" || result.command.type !== "agent:wake") throw new Error("expected ready wake");
    expect(result.command.config.model).toEqual({ kind: "custom", name: "my-ft-model" });

    // NULL ⇒ default.
    seedHappyPath({ bot: { modelName: null } });
    result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });
    if (result.state !== "ready" || result.command.type !== "agent:wake") throw new Error("expected ready wake");
    expect(result.command.config.model).toEqual({ kind: "default" });
  });

  it("skip: message_missing when the message no longer exists", async () => {
    mockGetWakeMessageScopeById.mockResolvedValue(null);

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_gone", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "message_missing" });
    expect(mockGetBotWakeContext).not.toHaveBeenCalled();
  });

  // Deleted: "skip: invalid_message_scope when the message has neither channelId
  // nor dmConversationId" — a message's channelId is now NOT NULL (DMs are
  // type=dm channels), so the both-null case can no longer occur.

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

  it("skip: forbidden when the bot lost membership/participant access before the queue drained", async () => {
    seedHappyPath({ canRead: false });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "forbidden" });
    expect(mockResolveNotificationEligibilityForUsers).not.toHaveBeenCalled();
  });

  it("skip: already_read when lastReadSeq >= message.seq (an earlier inboxPull already caught the bot up)", async () => {
    seedHappyPath({ isUnread: false });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "already_read" });
    expect(mockResolveUnreadNoticeChannel).not.toHaveBeenCalled();
  });

  it("skip: already_read also covers a cursor advanced past this message", async () => {
    seedHappyPath({ isUnread: false });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "already_read" });
  });

  it("skip: muted when current policy changes to nothing while a queue item waits", async () => {
    seedHappyPath();
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(new Map([["bot_1", {
      currentLevel: "nothing",
      hasAttention: true,
      isUnread: true,
      isReadable: true,
    }]]));

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "muted" });
    expect(mockResolveUnreadNoticeChannel).not.toHaveBeenCalled();
  });

  it("skip: mention_only for a plain message under the current mentions policy", async () => {
    seedHappyPath();
    mockResolveNotificationEligibilityForUsers.mockResolvedValue(new Map([["bot_1", {
      currentLevel: "mentions",
      hasAttention: false,
      isUnread: true,
      isReadable: true,
    }]]));

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });

    expect(result).toEqual({ state: "skip", reason: "mention_only" });
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

  it("writes a wake_trigger audit row with the correct payload after the gate passes", async () => {
    seedHappyPath();

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });
    expect(result.state).toBe("ready");
    expect(mockInsertBotAuditWakeTrigger).toHaveBeenCalledTimes(1);
    const [, args] = mockInsertBotAuditWakeTrigger.mock.calls[0]!;
    expect(args).toMatchObject({
      botId: "bot_1",
      payload: {
        messageId: "msg_1",
        channel: "/srv_1/general",
        seq: 7,
        senderId: "u_human",
        senderHandle: "@gustavo#0042",
        reason: "unread",
      },
    });
    // The per-day "handled" activity rollup rides the SAME atomic batch as the
    // audit insert: the upsert statement is built for this bot+today and handed
    // to insertBotAuditWakeTrigger as an extra batch statement — one round-trip,
    // not a separate hot-path write (Cecilia's perf red line).
    expect(mockBumpBotDailyActivityStatement).toHaveBeenCalledTimes(1);
    expect(mockBumpBotDailyActivityStatement).toHaveBeenCalledWith(
      expect.anything(),
      "bot_1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      "handled",
    );
    const [, , extraStatements] = mockInsertBotAuditWakeTrigger.mock.calls[0]!;
    expect(extraStatements).toEqual([{ __stmt: "bump" }]);
  });

  it("audit reason is 'mention' when the message carries a mention row for the bot", async () => {
    seedHappyPath();
    mockHasMentionForMessage.mockResolvedValue(true);

    await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });
    const [, args] = mockInsertBotAuditWakeTrigger.mock.calls[0]!;
    expect(args.payload.reason).toBe("mention");
  });

  it("NEVER writes an audit row when the wake was skipped (forbidden)", async () => {
    seedHappyPath({ canRead: false });

    await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });
    expect(mockInsertBotAuditWakeTrigger).not.toHaveBeenCalled();
    // Skipped wake never handled the message → no activity bump statement is
    // even built (rides the same post-gate chokepoint as the audit write).
    expect(mockBumpBotDailyActivityStatement).not.toHaveBeenCalled();
  });

  it("wake still fires when the audit insert throws (best-effort, MUST NOT gate the wake)", async () => {
    seedHappyPath();
    mockInsertBotAuditWakeTrigger.mockRejectedValue(new Error("d1 blip"));

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });
    expect(result.state).toBe("ready");
  });

  it("wake still fires when the sender lookup fails — audit is skipped silently", async () => {
    seedHappyPath();
    mockGetUsersByIds.mockRejectedValue(new Error("d1 blip"));

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });
    expect(result.state).toBe("ready");
    expect(mockInsertBotAuditWakeTrigger).not.toHaveBeenCalled();
  });

  it("audit is skipped silently when the bot has no owner (unbound owner column)", async () => {
    seedHappyPath({ bot: { ownerUserId: null } });

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" });
    expect(result.state).toBe("ready");
    expect(mockInsertBotAuditWakeTrigger).not.toHaveBeenCalled();
    expect(mockGetUsersByIds).not.toHaveBeenCalled();
  });

  it("calls the ws-do internal broadcast route with the shape ws-durable.ts emits for daemon frames (when env is provided)", async () => {
    seedHappyPath();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const env = { WS_DO_WORKER: { fetch: fetchMock } };

    await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/internal/broadcast-bot-audit-event");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      botId: "bot_1",
      ownerUserId: "owner_1",
      id: "evt_1",
      kind: "wake_trigger",
      payload: {
        messageId: "msg_1",
        channel: "/srv_1/general",
        seq: 7,
        reason: "unread",
      },
    });
  });

  it("wake still fires when the ws-do broadcast fetch throws — broadcast is best-effort", async () => {
    seedHappyPath();
    const fetchMock = vi.fn(async () => { throw new Error("network down") });
    const env = { WS_DO_WORKER: { fetch: fetchMock } };

    const result = await buildUnreadWakeCommand(fakeDb, { messageId: "msg_1", botUserId: "bot_1" }, env);
    expect(result.state).toBe("ready");
  });
});
