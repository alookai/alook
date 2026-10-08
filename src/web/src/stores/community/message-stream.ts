"use client"

import { useSelector } from "@tanstack/react-store"
import { useCommunityRuntime } from "./runtime"
import type { MessageScope } from "@/lib/community/message-stream"
import { EMPTY_STORED, messageScopeKey } from "./message-stream-store"

export { createMessageStreamStore } from "./message-stream-store"

export function useMessageOverlayIds(scope: MessageScope) {
  const key = messageScopeKey(scope)
  return useSelector(useCommunityRuntime().messageStream, (current) => current.entries.get(key)?.state ?? EMPTY_STORED)
}
