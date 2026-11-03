import { truncateMessagePreview } from "../constants/community";
import { messagePreviewText, type MessagePreviewInput } from "../lib/message-preview";

export type CommunityNotificationConversationKind = "dm" | "channel" | "thread";

export interface CommunityNotificationCopyInput extends MessagePreviewInput {
  conversationKind: CommunityNotificationConversationKind;
  authorName: string | null;
  content: string;
  serverName?: string | null;
  channelName?: string | null;
  parentChannelName?: string | null;
}

export interface CommunityNotificationCopy {
  title: string;
  body: string;
}

function displayName(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export function buildCommunityNotificationCopy(
  input: CommunityNotificationCopyInput,
): CommunityNotificationCopy {
  const authorName = displayName(input.authorName, "Alook");
  const preview = messagePreviewText(input) || "New message";

  if (input.conversationKind === "dm") {
    return {
      title: authorName,
      body: truncateMessagePreview(preview),
    };
  }

  const serverName = displayName(input.serverName, "Server");
  const title = input.conversationKind === "thread"
    ? `${serverName} · #${displayName(input.parentChannelName, "Channel")} · ${displayName(input.channelName, "Thread")}`
    : `${serverName} · #${displayName(input.channelName, "Channel")}`;

  return {
    title,
    body: truncateMessagePreview(`${authorName}: ${preview}`),
  };
}
