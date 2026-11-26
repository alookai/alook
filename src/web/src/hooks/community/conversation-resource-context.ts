"use client"

import { createContext, createElement, type ReactNode } from "react"
import type { ConversationResourceResult } from "./use-conversation-entry"

export type ConversationIntent = { href: string; resume?: boolean } | null | undefined

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
