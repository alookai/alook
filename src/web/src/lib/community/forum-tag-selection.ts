export const forumTagSelectionKey = (channelId: string) => `alook:forum-tag:${channelId}`

export function forumTagFromUrl(value: string | null | undefined): string | null {
  return value == null ? null : value.trim().toLowerCase() || "All"
}

export function readForumTagSelection(storage: Pick<Storage, "getItem">, channelId: string): string {
  return storage.getItem(forumTagSelectionKey(channelId)) || "All"
}

export function writeForumTagSelection(storage: Pick<Storage, "setItem" | "removeItem">, channelId: string, tag: string): void {
  if (tag === "All") storage.removeItem(forumTagSelectionKey(channelId))
  else storage.setItem(forumTagSelectionKey(channelId), tag)
  if (typeof window !== "undefined") {
    try { if (storage === window.localStorage) window.dispatchEvent(new StorageEvent("storage", { key: forumTagSelectionKey(channelId) })) } catch {}
  }
}

export function validateForumTagSelection(tag: string, availableTags: string[]): string {
  return tag === "All" || availableTags.includes(tag) ? tag : "All"
}
