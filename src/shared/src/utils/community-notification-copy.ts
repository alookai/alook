import { truncateMessagePreview } from "../constants/community";
import { stripInlineMarkup } from "./title";

export type CommunityNotificationConversationKind = "dm" | "channel" | "thread";

export interface CommunityNotificationCopyInput {
  conversationKind: CommunityNotificationConversationKind;
  authorName: string | null;
  content: string;
  attachmentContentTypes: ReadonlyArray<string | null | undefined>;
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

function attachmentFallback(contentTypes: ReadonlyArray<string | null | undefined>): string {
  const normalized = contentTypes.map((value) => value?.toLowerCase() ?? "");
  if (normalized.some((value) => value.startsWith("image/"))) return "Photo";
  if (normalized.some((value) => value.startsWith("video/"))) return "Video";
  if (normalized.some((value) => value.startsWith("audio/"))) return "Audio";
  if (normalized.length > 0) return "Attachment";
  return "New message";
}

export function buildCommunityNotificationCopy(
  input: CommunityNotificationCopyInput,
): CommunityNotificationCopy {
  const authorName = displayName(input.authorName, "Alook");
  const readable = stripInlineMarkup(input.content)
    .replace(/\s+/gu, " ")
    .trim();
  const preview = readable || attachmentFallback(input.attachmentContentTypes);

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
