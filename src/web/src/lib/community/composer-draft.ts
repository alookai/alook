

//
// Why JSON, not plain text: the composer holds @mention and /channel-ref pills
// as ProseMirror nodes. Plain text flattens them to literal `@label` / `/label`
// strings that restore as inert text, not pills. The JSON doc preserves those
// nodes (with their attrs) losslessly, so a restored draft renders identical
// pills. Attachments/replies are still not cached — text + pills only.
//

const PREFIX = "c-composer-draft:"
const COMPOSER_DRAFT_DEBOUNCE_MS = 300

type PendingDraft = {
  doc: unknown | null
  timer: ReturnType<typeof setTimeout>
}

const pendingDrafts = new Map<string, PendingDraft>()
let lifecycleListenersAttached = false

function flushAllComposerDrafts(): void {
  if (pendingDrafts.size === 0) return
  for (const [scope, pending] of [...pendingDrafts]) {
    clearTimeout(pending.timer)
    pendingDrafts.delete(scope)
    commitComposerDraft(scope, pending.doc)
  }
  syncDraftLifecycleListeners()
}

function handleDraftVisibilityChange(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    flushAllComposerDrafts()
  }
}

function syncDraftLifecycleListeners(): void {
  if (typeof window === "undefined") return
  if (pendingDrafts.size > 0 && !lifecycleListenersAttached) {
    lifecycleListenersAttached = true
    if (typeof window.addEventListener === "function") {
      window.addEventListener("beforeunload", flushAllComposerDrafts)
      window.addEventListener("pagehide", flushAllComposerDrafts)
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", handleDraftVisibilityChange)
    }
  } else if (pendingDrafts.size === 0 && lifecycleListenersAttached) {
    lifecycleListenersAttached = false
    if (typeof window.removeEventListener === "function") {
      window.removeEventListener("beforeunload", flushAllComposerDrafts)
      window.removeEventListener("pagehide", flushAllComposerDrafts)
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", handleDraftVisibilityChange)
    }
  }
}

function commitComposerDraft(scope: string, doc: unknown | null): void {
  if (typeof window === "undefined") return
  const key = draftStorageKey(scope)
  try {
    if (doc == null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(doc))
  } catch {

  }
}

export function draftStorageKey(scope: string): string {
  return `${PREFIX}${scope}`
}

export function readComposerDraft(scope: string): unknown | null {
  if (typeof window === "undefined") return null
  const pending = pendingDrafts.get(scope)
  if (pending) return pending.doc
  try {
    const raw = localStorage.getItem(draftStorageKey(scope))
    if (!raw) return null
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

export function writeComposerDraft(scope: string, doc: unknown | null): void {
  const existing = pendingDrafts.get(scope)
  if (existing) {
    clearTimeout(existing.timer)
    pendingDrafts.delete(scope)
    syncDraftLifecycleListeners()
  }
  commitComposerDraft(scope, doc)
}

export function scheduleComposerDraftWrite(
  scope: string,
  doc: unknown | null,
  delayMs = COMPOSER_DRAFT_DEBOUNCE_MS,
): void {
  if (typeof window === "undefined") return
  const existing = pendingDrafts.get(scope)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    const current = pendingDrafts.get(scope)
    if (!current || current.timer !== timer) return
    pendingDrafts.delete(scope)
    syncDraftLifecycleListeners()
    commitComposerDraft(scope, current.doc)
  }, delayMs)
  pendingDrafts.set(scope, { doc, timer })
  syncDraftLifecycleListeners()
}

export function flushComposerDraft(scope: string): void {
  const existing = pendingDrafts.get(scope)
  if (!existing) return
  clearTimeout(existing.timer)
  pendingDrafts.delete(scope)
  syncDraftLifecycleListeners()
  commitComposerDraft(scope, existing.doc)
}

export function clearComposerDraft(scope: string): void {
  const existing = pendingDrafts.get(scope)
  if (existing) {
    clearTimeout(existing.timer)
    pendingDrafts.delete(scope)
    syncDraftLifecycleListeners()
  }
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(draftStorageKey(scope))
  } catch {

  }
}
