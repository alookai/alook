"use client"

import { noop, type QueryClient } from "@tanstack/react-query"
import { conversationEntryOptions } from "./conversation-entry"

export type ConversationNavigationTarget = {
  href: string
  viewerId: string
  channelId: string
  serverId?: string
  scopeKind: "channel" | "dm"
  expectedSurfaceKind?: "channel" | "forum" | "thread" | "dm"
  anchorMessageId?: string
}

export function startConversationNavigationWarmup(client: QueryClient, target: ConversationNavigationTarget) {
  const options = conversationEntryOptions(client, {
    channelId: target.channelId, serverId: target.serverId ?? null, anchorMessageId: target.anchorMessageId,
  })
  return client.query({ ...options, select: undefined }).catch(noop)
}
