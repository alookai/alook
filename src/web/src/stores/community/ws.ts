"use client"

import { useSelector } from "@tanstack/react-store"
import { useCommunityRuntime } from "./runtime"
import { createCommunityWsStore } from "./ws-store"

export { createCommunityWsStore, SEEN_MESSAGE_MAX, SEEN_MESSAGE_TRIM_TO, SEEN_DELIVERY_OPERATION_MAX, SEEN_DELIVERY_OPERATION_TRIM_TO } from "./ws-store"
export type { CommunityWsConnectionStatus } from "./ws-store"

export function useCommunityWsStore<T>(selector: (state: ReturnType<ReturnType<typeof createCommunityWsStore>["get"]>) => T) {
  return useSelector(useCommunityRuntime().ws, selector)
}
