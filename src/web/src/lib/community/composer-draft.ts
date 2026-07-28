// Per-channel-per-server composer draft cache. The community composer remounts
// on every channel/DM switch (`ChannelView`/`DmView` are keyed by id), so its
// in-editor text is otherwise lost on navigate. These helpers persist the raw
// message text (only text — attachments/replies are not cached) under a key
// scoped to the conversation, so returning restores the draft.
//
// Pure wrappers over localStorage (guarded for SSR/quota) rather than the
// `useLocalStorage` hook: the composer's text lives in the tiptap editor, not
// React state, so it hydrates/persists imperatively at mount/update/send.

const PREFIX = "c-composer-draft:"

export function draftStorageKey(scope: string): string {
  return `${PREFIX}${scope}`
}

export function readComposerDraft(scope: string): string {
  if (typeof window === "undefined") return ""
  try {
    return localStorage.getItem(draftStorageKey(scope)) ?? ""
  } catch {
    return ""
  }
}

export function writeComposerDraft(scope: string, text: string): void {
  if (typeof window === "undefined") return
  const key = draftStorageKey(scope)
  try {
    // An empty (or whitespace-only) draft is the absence of a draft — remove
    // the key so a stale entry never resurfaces and localStorage stays clean.
    if (text.trim() === "") localStorage.removeItem(key)
    else localStorage.setItem(key, text)
  } catch {
    /* quota exceeded — silently ignore, same as useLocalStorage */
  }
}

export function clearComposerDraft(scope: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(draftStorageKey(scope))
  } catch {
    /* ignore */
  }
}
