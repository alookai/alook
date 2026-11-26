"use client"

import { createContext, createElement, type ReactNode } from "react"
import type { QueryClient, QueryObserverResult, UseQueryResult } from "@tanstack/react-query"
import type {
  ConversationEntryResource,
  ConversationWindowScope,
  conversationEntryOptions,
  currentConversationReadState,
  findConversationDisplayWindow,
} from "@/lib/community/conversation-entry"
import type { ChannelRow } from "@/lib/community-db/schema"

export type ConversationIntent = { href: string; resume?: boolean } | null | undefined

type ConversationResourceInput = {
  channelId: string
  serverId: string | null
  anchorMessageId: string | null
  tag: string | null
  preferTail: boolean
  newAfterSeq: number | null
}

export type ConversationResourceResult = {
  client: QueryClient
  cachedResource: ConversationEntryResource | undefined
  scope: ConversationWindowScope | undefined
  currentPointer: ReturnType<typeof currentConversationReadState>
  displayWindowReady: boolean
  windowReady: boolean
  displayWindow: ReturnType<typeof findConversationDisplayWindow>
  input: ConversationResourceInput
  options: ReturnType<typeof conversationEntryOptions>
  query: UseQueryResult<ConversationEntryResource, Error>
  canonical: ChannelRow | undefined
  resource: ConversationEntryResource | undefined
  canRead: boolean
  revoked: boolean
  denied: boolean
  anchorMissing: boolean
  verificationError: Error | null
  verificationPending: boolean
  verificationFetching: boolean
  verificationFailed: boolean
  retryVerification: () => Promise<QueryObserverResult<ConversationEntryResource, Error>>
}

export type SharedConversationResource = {
  scopeKey: string
  intent: ConversationIntent
  networkEnabled: boolean
  value: ConversationResourceResult
}

export const ConversationResourceContext = createContext<SharedConversationResource | null>(null)

export function ConversationResourceProvider({
  value,
  children,
}: {
  value: SharedConversationResource | null
  children: ReactNode
}) {
  return createElement(ConversationResourceContext.Provider, { value }, children)
}
