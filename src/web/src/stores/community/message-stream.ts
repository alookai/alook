"use client"

import { useSelector } from "@tanstack/react-store"
import type { QueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { getCommunityRuntime, useCommunityRuntime } from "./runtime"
import { useMessageProjection } from "@/lib/community-db/projections"
import type { MessageOverlayState, MessageScope, CanonicalMessage } from "@/lib/community/message-stream"
import { EMPTY_STORED, hydrate, messageScopeKey } from "./message-stream-store"

export { createMessageStreamStore } from "./message-stream-store"

export function getMessageOverlay(queryClient: QueryClient, scope: MessageScope): MessageOverlayState {
  return getCommunityRuntime(queryClient).messageStream.actions.overlayFor(scope)
}

export function useMessageOverlay(scope: MessageScope): MessageOverlayState {
  const key = messageScopeKey(scope)
  const state = useSelector(useCommunityRuntime().messageStream, (current) => current.entries.get(key)?.state ?? EMPTY_STORED)
  const messages = useMessageProjection(scope.id, state.liveIds)
  return useMemo(() => hydrate(state, new Map((messages ?? []).flatMap((message) => typeof message.seq === "number" ? [[message.id, message as CanonicalMessage] as const] : []))), [state, messages])
}
