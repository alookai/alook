"use client"

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
} from "react"
import type { MessageContextTarget } from "./message-channel-controller-types"

type MessagePaneNavigation = {
  channelId: string
  jumpToSeq: (seq: number) => void
  openMessageContext: (target: MessageContextTarget) => void
}

const MessagePaneNavigationContext = createContext<MessagePaneNavigation | null>(null)

export function MessagePaneNavigationProvider({
  channelId,
  jumpToSeq,
  openMessageContext,
  children,
}: MessagePaneNavigation & { children: ReactNode }) {
  const value = useMemo(
    () => ({ channelId, jumpToSeq, openMessageContext }),
    [channelId, jumpToSeq, openMessageContext],
  )

  return (
    <MessagePaneNavigationContext.Provider value={value}>
      {children}
    </MessagePaneNavigationContext.Provider>
  )
}

export function useMessagePaneNavigation() {
  return useContext(MessagePaneNavigationContext)
}
