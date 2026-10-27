"use client"

import { useCallback, useSyncExternalStore } from "react"
import { forumTagSelectionKey, readForumTagSelection } from "@/lib/community/forum-tag-selection"

export function useStoredForumTag(channelId: string | null) {
  const read = useCallback(() => {
    if (!channelId) return "All"
    try { return readForumTagSelection(window.localStorage, channelId) } catch { return "All" }
  }, [channelId])
  const subscribe = useCallback((notify: () => void) => {
    if (!channelId) return () => {}
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === forumTagSelectionKey(channelId)) notify() }
    window.addEventListener("storage", changed)
    return () => window.removeEventListener("storage", changed)
  }, [channelId])
  return useSyncExternalStore(subscribe, read, () => channelId ? null : "All")
}
