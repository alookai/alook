import { describe, expect, it } from "vitest";
import { parseMessageDeliveryBatch } from "../src/community-message-delivery";

const messageEvent = {
  type: "community:message.create" as const,
  channelId: "thread-1",
  serverId: "server-1",
  parentChannelId: "forum-1",
  message: {
    id: "message-1",
    seq: 4,
    authorId: "u1",
    authorName: "Alice",
    content: "hello",
    type: "chat" as const,
    createdAt: "2026-08-18T00:00:00.000Z",
  },
};

const valid = {
  messageId: "message-1",
  messageEvent,
  contentUserIds: ["u1", "u2"],
  unreadPlainUserIds: [],
  unreadMentionUserIds: ["u2"],
  mentionUserIds: ["u2"],
  memberAdded: { userId: "u1", serverId: "server-1", channelId: "thread-1" },
  parentProjection: {
    type: "community:channel.child_update" as const,
    parentChannelId: "forum-1",
    channelId: "thread-1",
    changes: { messageCount: 4, lastMessageAt: "2026-08-18T00:00:00.000Z" },
  },
  parentProjectionUserIds: ["u1", "u2", "u3"],
};

describe("message delivery batch", () => {
  it("accepts a strict message-specific batch with separate parent audience", () => {
    expect(parseMessageDeliveryBatch(valid)).toEqual({ ok: true, batch: valid });
  });

  it("accepts a thread mention-only nonparticipant", () => {
    const batch = {
      ...valid,
      contentUserIds: ["u1"],
      unreadMentionUserIds: [],
      mentionUserIds: ["parent-visible-nonparticipant"],
    };
    expect(parseMessageDeliveryBatch(batch).ok).toBe(true);
  });

  it.each([
    { ...valid, extra: true },
    { ...valid, messageId: "other" },
    { ...valid, contentUserIds: ["u1", "u1"] },
    { ...valid, unreadPlainUserIds: ["outside"] },
    { ...valid, unreadPlainUserIds: ["u2"], unreadMentionUserIds: ["u2"] },
    { ...valid, parentProjectionUserIds: undefined },
    { ...valid, memberAdded: { ...valid.memberAdded, channelId: "other" } },
    { ...valid, memberAdded: { ...valid.memberAdded, serverId: "other" } },
    {
      ...valid,
      messageEvent: { ...messageEvent, serverId: undefined, parentChannelId: undefined },
      memberAdded: { userId: "u1", serverId: "server-1", channelId: "thread-1" },
      parentProjection: undefined,
      parentProjectionUserIds: undefined,
    },
  ])("rejects an invalid batch", (batch) => {
    expect(parseMessageDeliveryBatch(batch).ok).toBe(false);
  });
});
