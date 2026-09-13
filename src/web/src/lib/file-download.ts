"use client"

import { useCallback, useSyncExternalStore } from "react"
import { downloadUrl, fileSaveMessage, type FileSaveResult } from "./file-save"

type FileDownloadTarget = { name: string; url: string }
type FileDownloadState = { status: "idle" } | { status: "downloading" } | FileSaveResult
const idle: FileDownloadState = { status: "idle" }
const states = new Map<string, FileDownloadState>()
const listeners = new Map<string, Set<() => void>>()
const flights = new Map<string, { controller: AbortController; promise: Promise<void> }>()

export function fileDownloadKey(target: FileDownloadTarget): string { return target.url }
export function readFileDownloadState(key: string): FileDownloadState { return states.get(key) ?? idle }
export function fileDownloadStatusText(state: FileDownloadState): string | null {
  if (state.status === "downloading") return "Downloading…"
  return state.status === "idle" ? null : fileSaveMessage(state)
}
function publish(key: string, state: FileDownloadState): void {
  states.set(key, state)
  if (states.size > 128) {
    for (const stale of states.keys()) {
      if (stale !== key && !flights.has(stale) && !listeners.has(stale)) states.delete(stale)
      if (states.size <= 128) break
    }
  }
  for (const listener of listeners.get(key) ?? []) listener()
}
export function cancelFileDownload(key: string): void { flights.get(key)?.controller.abort() }
export function startFileDownload(target: FileDownloadTarget): Promise<void> {
  const key = fileDownloadKey(target)
  const existing = flights.get(key)
  if (existing) return existing.promise
  const controller = new AbortController()
  const promise = Promise.resolve()
    .then(() => downloadUrl(target.url, target.name, { signal: controller.signal }))
    .then(result => { if (flights.get(key)?.controller === controller) publish(key, result) })
    .finally(() => { if (flights.get(key)?.promise === promise) flights.delete(key) })
  flights.set(key, { controller, promise })
  publish(key, { status: "downloading" })
  return promise
}
export function useFileDownload(target: FileDownloadTarget) {
  const key = fileDownloadKey(target)
  const subscribe = useCallback((listener: () => void) => {
    const set = listeners.get(key) ?? new Set<() => void>()
    set.add(listener)
    listeners.set(key, set)
    return () => { set.delete(listener); if (!set.size) listeners.delete(key) }
  }, [key])
  const snapshot = useCallback(() => readFileDownloadState(key), [key])
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  const start = useCallback(() => startFileDownload({ url: target.url, name: target.name }), [target.url, target.name])
  const cancel = useCallback(() => cancelFileDownload(key), [key])
  return { state, start, cancel }
}
export function resetFileDownloadsForTest(): void {
  for (const flight of flights.values()) flight.controller.abort()
  flights.clear(); states.clear(); listeners.clear()
}
