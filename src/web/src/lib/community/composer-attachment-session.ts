import { createStore } from "@tanstack/store"

export const COMPOSER_ATTACHMENT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000
const COMPOSER_ATTACHMENT_SESSION_MAX_SCOPES = 50
export const COMPOSER_ATTACHMENT_SESSION_MAX_BYTES = 256 * 1024 * 1024

export type ComposerAttachmentSessionFile = {
  draftId: string
  file: File
}

type ComposerAttachmentSessionEntry = ComposerAttachmentSessionFile & {
  touchedAt: number
}

export type ComposerAttachmentSessionWriteResult = {
  accepted: boolean
  evictedScopes: number
}

const attachmentSessions = createStore<ReadonlyMap<string, readonly ComposerAttachmentSessionEntry[]>>(new Map())

function removeScope(scope: string) {
  attachmentSessions.setState((current) => {
    if (!current.has(scope)) return current
    const next = new Map(current)
    next.delete(scope)
    return next
  })
}

function scopeBytes(entries: readonly ComposerAttachmentSessionEntry[]) {
  return entries.reduce((total, entry) => total + entry.file.size, 0)
}

function totalBytes() {
  let total = 0
  for (const entries of attachmentSessions.get().values()) total += scopeBytes(entries)
  return total
}

function touchScope(
  scope: string,
  entries: readonly ComposerAttachmentSessionEntry[],
  now: number,
) {
  const touched = entries.map((entry) => ({ ...entry, touchedAt: now }))
  attachmentSessions.setState((current) => {
    const next = new Map(current)
    next.delete(scope)
    if (touched.length > 0) next.set(scope, touched)
    return next
  })
  return touched
}

function isExpired(entries: readonly ComposerAttachmentSessionEntry[], now: number) {
  return entries.length === 0 || now - entries[0].touchedAt >= COMPOSER_ATTACHMENT_SESSION_TTL_MS
}

function removeExpiredInactiveScopes(activeScope: string, now: number) {
  let removed = 0
  attachmentSessions.setState((current) => {
    const next = new Map(current)
    for (const [scope, entries] of current) {
      if (scope !== activeScope && isExpired(entries, now)) {
        next.delete(scope)
        removed++
      }
    }
    return removed ? next : current
  })
  return removed
}

/**
 * Returns a same-tab snapshot and promotes the scope to most-recently-used.
 * A scope that was already idle beyond the TTL expires before it can restore.
 */
export function readComposerAttachmentSession(
  scope: string,
  now = Date.now(),
): ComposerAttachmentSessionFile[] {
  const entries = attachmentSessions.get().get(scope)
  if (!entries) {
    removeExpiredInactiveScopes(scope, now)
    return []
  }
  if (isExpired(entries, now)) {
    removeScope(scope)
    removeExpiredInactiveScopes(scope, now)
    return []
  }
  const touched = touchScope(scope, entries, now)
  removeExpiredInactiveScopes(scope, now)
  return touched.map(({ draftId, file }) => ({ draftId, file }))
}

/**
 * Registers raw Files synchronously before thumbnail preparation. The active
 * scope is protected; expired and then least-recently-used inactive scopes are
 * discarded to make the current user action fit.
 */
export function appendComposerAttachmentSession(
  scope: string,
  files: readonly ComposerAttachmentSessionFile[],
  now = Date.now(),
): ComposerAttachmentSessionWriteResult {
  if (files.length === 0) return { accepted: true, evictedScopes: 0 }

  const current = attachmentSessions.get().get(scope) ?? []
  const currentIds = new Set(current.map((entry) => entry.draftId))
  const additions = files
    .filter((entry) => !currentIds.has(entry.draftId))
    .map((entry) => ({ ...entry, touchedAt: now }))
  const nextActive = [...current, ...additions]

  // A legal Community draft is at most 10 × 25 MiB, so this only rejects an
  // independently invalid active scope rather than sacrificing current work.
  if (scopeBytes(nextActive) > COMPOSER_ATTACHMENT_SESSION_MAX_BYTES) {
    return { accepted: false, evictedScopes: 0 }
  }

  let evictedScopes = removeExpiredInactiveScopes(scope, now)
  const activeWasPresent = attachmentSessions.get().has(scope)
  const projectedScopeCount = () => attachmentSessions.get().size + (activeWasPresent ? 0 : 1)
  const projectedBytes = () => totalBytes() - scopeBytes(current) + scopeBytes(nextActive)

  while (
    projectedScopeCount() > COMPOSER_ATTACHMENT_SESSION_MAX_SCOPES ||
    projectedBytes() > COMPOSER_ATTACHMENT_SESSION_MAX_BYTES
  ) {
    const oldestInactive = [...attachmentSessions.get().keys()].find((key) => key !== scope)
    if (!oldestInactive) return { accepted: false, evictedScopes }
    removeScope(oldestInactive)
    evictedScopes++
  }

  touchScope(scope, nextActive, now)
  return { accepted: true, evictedScopes }
}

export function removeComposerAttachmentSessionFiles(
  scope: string,
  draftIds: readonly string[],
  now = Date.now(),
) {
  if (draftIds.length === 0) return
  const entries = attachmentSessions.get().get(scope)
  if (!entries) return
  const removed = new Set(draftIds)
  touchScope(
    scope,
    entries.filter((entry) => !removed.has(entry.draftId)),
    now,
  )
}

export function clearComposerAttachmentSessionsForAccount(accountId: string) {
  attachmentSessions.setState((current) => new Map([...current].filter(([scope]) => !scope.startsWith(`${accountId}:`))))
}

export function clearComposerAttachmentSession(scope: string) {
  removeScope(scope)
}

export function transferComposerAttachmentSession(
  scope: string,
): ComposerAttachmentSessionFile[] {
  const entries = attachmentSessions.get().get(scope) ?? []
  removeScope(scope)
  return entries.map(({ draftId, file }) => ({ draftId, file }))
}

export function getComposerAttachmentSessionStats() {
  return { scopes: attachmentSessions.get().size, bytes: totalBytes() }
}

export function resetComposerAttachmentSessionsForTest() {
  attachmentSessions.setState(() => new Map())
}
