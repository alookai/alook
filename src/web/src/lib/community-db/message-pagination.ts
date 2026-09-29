import type { MessagesPage, MessagesPageParam } from "@/lib/community/models/message"
import { communityKeys } from "@/lib/query-keys"
import type { CursorPage } from "./cursor-pager"

export type MessageAccessScope = {
  accountId: string
  kind: "server-channel" | "dm"
  serverId: string | null
  channelId: string
}

export type MessageSequence = {
  base: { mode: "tail" } | { mode: "anchor"; anchor: string }
  direction: "older" | "newer"
  order: readonly ["seq", "asc", "id", "asc"]
}

export type MessagePageDirection = "older" | "newer"

export function isMessageResourceQueryKey(
  queryKey: readonly unknown[],
  match: { accountId?: string; channelId?: string } = {},
) {
  const namespace = queryKey[4]
  const channelIndex = namespace === "rows" || namespace === "pages" ? 7 : 6
  return queryKey[0] === "community"
    && queryKey[1] === "db"
    && typeof queryKey[2] === "string"
    && queryKey[3] === "message-resource"
    && (match.accountId === undefined || queryKey[2] === match.accountId)
    && (match.channelId === undefined || queryKey[channelIndex] === match.channelId)
}

function normalizedTag(tag: string | null | undefined) {
  const value = tag?.trim()
  return value ? value : null
}

function sequenceKey(sequence: MessageSequence) {
  const base = sequence.base.mode === "tail"
    ? ["tail"] as const
    : ["anchor", sequence.base.anchor] as const
  return [...base, sequence.direction, ...sequence.order] as const
}

export function messageResourceQueryKey(
  scope: MessageAccessScope,
  tag: string | null | undefined,
  sequence: MessageSequence,
) {
  return [
    ...communityKeys.communityDb(scope.accountId),
    "message-resource",
    scope.kind,
    scope.serverId,
    scope.channelId,
    normalizedTag(tag),
    ...sequenceKey(sequence),
  ] as const
}

export function messageRowsQueryKey(
  scope: MessageAccessScope,
  tag: string | null | undefined,
  sequence: MessageSequence,
) {
  const resource = messageResourceQueryKey(scope, tag, sequence)
  return [...resource.slice(0, 4), "rows", ...resource.slice(4)] as const
}

export function messagePagesQueryKey(
  scope: MessageAccessScope,
  tag: string | null | undefined,
  sequence: MessageSequence,
) {
  const resource = messageResourceQueryKey(scope, tag, sequence)
  return [...resource.slice(0, 4), "pages", ...resource.slice(4)] as const
}

export function buildCommunityMessagesUrl(
  channelId: string,
  page: MessagesPageParam,
  tag?: string | null,
) {
  const params = new URLSearchParams()
  const filter = normalizedTag(tag)
  if (filter) params.set("tag", filter)
  switch (page.mode) {
    case "newest":
      break
    case "older":
      params.set("cursor", page.cursor)
      break
    case "newer":
      params.set("since", page.cursor)
      break
    case "since":
      params.set("since", page.since)
      break
    case "anchor":
      params.set("anchor", page.anchor)
      break
  }
  const query = params.toString()
  const base = `/api/community/channels/${encodeURIComponent(channelId)}/messages`
  return query ? `${base}?${query}` : base
}

export function messageCursorPage(
  page: MessagesPage,
  direction: MessagePageDirection,
): CursorPage<MessagesPage["messages"][number]> {
  const hasMore = direction === "older"
    ? page.hasMoreOlder ?? page.hasMore ?? false
    : page.hasMoreNewer ?? false
  if (!hasMore) return { rows: page.messages, nextCursor: null }
  const cursor = direction === "older"
    ? page.olderCursor ?? page.cursor
    : page.newerCursor
  if (!cursor) {
    throw new TypeError(`Message page declared ${direction} continuation without a cursor`)
  }
  return { rows: page.messages, nextCursor: cursor }
}
