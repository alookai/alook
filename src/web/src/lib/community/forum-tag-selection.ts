const keyFor = (channelId: string) => `alook:forum-tag:${channelId}`

export function readForumTagSelection(storage: Pick<Storage, "getItem">, channelId: string): string {
  return storage.getItem(keyFor(channelId)) || "All"
}

export function writeForumTagSelection(storage: Pick<Storage, "setItem" | "removeItem">, channelId: string, tag: string): void {
  if (tag === "All") storage.removeItem(keyFor(channelId))
  else storage.setItem(keyFor(channelId), tag)
}

export function validateForumTagSelection(tag: string, availableTags: string[]): string {
  return tag === "All" || availableTags.includes(tag) ? tag : "All"
}
