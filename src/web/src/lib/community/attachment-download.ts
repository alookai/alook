"use client"

import { useCallback, useSyncExternalStore } from "react"

export type AttachmentDownloadTarget = {
  name: string
  url: string
}

export type AttachmentDownloadState =
  | { status: "idle" }
  | { status: "downloading" }
  | { status: "success" }
  | { status: "error"; message: string }

const IDLE_STATE: AttachmentDownloadState = { status: "idle" }
const states = new Map<string, AttachmentDownloadState>()
const listeners = new Map<string, Set<() => void>>()
const inFlight = new Map<string, Promise<void>>()

export function attachmentDownloadKey(attachment: AttachmentDownloadTarget): string {
  return attachment.url
}

export function readAttachmentDownloadState(key: string): AttachmentDownloadState {
  return states.get(key) ?? IDLE_STATE
}

export function attachmentDownloadStatusText(state: AttachmentDownloadState): string | null {
  if (state.status === "downloading") return "Downloading…"
  if (state.status === "success") return "Download started"
  if (state.status === "error") return "Couldn’t download — retry"
  return null
}

function publish(key: string, state: AttachmentDownloadState): void {
  states.set(key, state)
  for (const listener of listeners.get(key) ?? []) listener()
}

function subscribe(key: string, listener: () => void): () => void {
  const keyListeners = listeners.get(key) ?? new Set<() => void>()
  keyListeners.add(listener)
  listeners.set(key, keyListeners)
  return () => {
    keyListeners.delete(listener)
    if (keyListeners.size === 0) listeners.delete(key)
  }
}

async function acquireAndSave(attachment: AttachmentDownloadTarget): Promise<void> {
  let objectUrl: string | null = null
  let anchor: HTMLAnchorElement | null = null
  try {
    const response = await fetch(attachment.url, { credentials: "same-origin" })
    if (!response.ok) throw new Error(`Couldn’t download this attachment (${response.status})`)
    const blob = await response.blob()
    objectUrl = URL.createObjectURL(blob)
    anchor = document.createElement("a")
    anchor.href = objectUrl
    anchor.download = attachment.name
    anchor.hidden = true
    anchor.click()
  } finally {
    anchor?.remove()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

export function startAttachmentDownload(attachment: AttachmentDownloadTarget): Promise<void> {
  const key = attachmentDownloadKey(attachment)
  const active = inFlight.get(key)
  if (active) return active

  const target = { name: attachment.name, url: attachment.url }
  const task = Promise.resolve()
    .then(() => acquireAndSave(target))
    .then(() => publish(key, { status: "success" }))
    .catch((error: unknown) => {
      publish(key, {
        status: "error",
        message: error instanceof Error ? error.message : "Couldn’t download this attachment",
      })
    })
    .finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key)
    })

  inFlight.set(key, task)
  publish(key, { status: "downloading" })
  return task
}

export function useAttachmentDownload(attachment: AttachmentDownloadTarget): {
  state: AttachmentDownloadState
  start: () => Promise<void>
} {
  const key = attachmentDownloadKey(attachment)
  const subscribeToKey = useCallback(
    (listener: () => void) => subscribe(key, listener),
    [key],
  )
  const getSnapshot = useCallback(() => readAttachmentDownloadState(key), [key])
  const state = useSyncExternalStore(subscribeToKey, getSnapshot, getSnapshot)
  const start = useCallback(
    () => startAttachmentDownload({ name: attachment.name, url: attachment.url }),
    [attachment.name, attachment.url],
  )
  return { state, start }
}

export function resetAttachmentDownloadsForTest(): void {
  states.clear()
  listeners.clear()
  inFlight.clear()
}
