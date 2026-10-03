"use client"

import { useCallback, useLayoutEffect, useMemo } from "react"
import { createStore } from "@tanstack/react-store"
import { QueryObserver, queryOptions, useQuery, isCancelledError, type QueryKey } from "@tanstack/react-query"
import { applicationKey, useApplicationOwner, captureApplicationOwner, assertApplicationOwner, type ApplicationOwner } from "./application-owner"
import { downloadUrl, fileSaveMessage, type FileSaveResult } from "./file-save"
import { isAbortError } from "./errors"

type FileDownloadTarget = { name: string; url: string }
export type FileDownloadState = { status: "idle" } | { status: "downloading" } | FileSaveResult
const idle: FileDownloadState = { status: "idle" }

export function fileDownloadKey(owner: ApplicationOwner, target: FileDownloadTarget) { return applicationKey(owner, "file-download", target.url, target.name) }
export function readFileDownloadState(owner: ApplicationOwner, key: QueryKey): FileDownloadState {
  const query = owner.queryClient.getQueryState<FileSaveResult>(key)
  return query?.fetchStatus === "fetching" ? { status: "downloading" } : query?.data ?? idle
}
export function fileDownloadStatusText(state: FileDownloadState): string | null {
  if (state.status === "downloading") return "Downloading…"
  return state.status === "idle" ? null : fileSaveMessage(state)
}
function downloadOptions(owner: ApplicationOwner, target: FileDownloadTarget) {
  return queryOptions({ queryKey: fileDownloadKey(owner, target), staleTime: 0, gcTime: 60_000, retry: false,
    queryFn: async ({ signal }) => {
      const token = captureApplicationOwner(owner)
      const assertActive = () => assertApplicationOwner(token, signal)
      assertActive()
      try {
        const receipt = await downloadUrl(target.url, target.name, { signal, assertActive })
        assertActive()
        return receipt
      } catch (error) { assertActive(); throw error }
    },
  })
}

export async function cancelFileDownload(owner: ApplicationOwner, key: QueryKey): Promise<void> {
  const token = captureApplicationOwner(owner), qc = owner.queryClient
  assertApplicationOwner(token)
  const original = qc.getQueryCache().find({ queryKey: key, exact: true })
  await qc.cancelQueries({ queryKey: key, exact: true })
  assertApplicationOwner(token)
  if (original && qc.getQueryCache().find({ queryKey: key, exact: true }) === original) qc.setQueryData(key, { status: "cancelled" })
}

export async function startFileDownload(owner: ApplicationOwner, target: FileDownloadTarget, signal?: AbortSignal): Promise<FileSaveResult> {
  const token = captureApplicationOwner(owner)
  assertApplicationOwner(token, signal)
  const options = downloadOptions(owner, target)
  const observer = new QueryObserver(owner.queryClient, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(() => undefined)
  let released = false
  const release = () => { if (released) return; released = true; unsubscribe() }
  signal?.addEventListener("abort", release, { once: true })
  try {
    assertApplicationOwner(token, signal)
    const receipt = await owner.queryClient.fetchQuery(options)
    assertApplicationOwner(token, signal)
    return receipt
  } catch (error) {
    if (isCancelledError(error) || isAbortError(error) || signal?.aborted) return { status: "cancelled" }
    throw error
  } finally {
    signal?.removeEventListener("abort", release)
    release()
  }
}

export function useFileDownload(target: FileDownloadTarget) {
  const owner = useApplicationOwner()
  const view = useMemo(() => ({ scope: [owner, target.url, target.name], store: createStore({ active: true, generation: 0, controller: new AbortController() }) }), [owner, target.url, target.name]).store
  useLayoutEffect(() => {
    view.setState((state) => ({ ...state, active: true, controller: state.controller.signal.aborted ? new AbortController() : state.controller }))
    return () => {
      const original = view.get().controller
      view.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
      original.abort()
    }
  }, [view])
  const query = useQuery({ ...downloadOptions(owner, target), enabled: false }, owner.queryClient)
  const state: FileDownloadState = query.isFetching ? { status: "downloading" } : query.data ?? idle
  const start = useCallback(async (onComplete?: (receipt: FileSaveResult) => void) => {
    try {
      const original = view.get(), token = captureApplicationOwner(owner)
      assertApplicationOwner(token)
      if (!original.active) return { status: "cancelled" } as FileSaveResult
      const receipt = await startFileDownload(owner, target, original.controller.signal)
      assertApplicationOwner(token)
      const current = view.get()
      if (!current.active || current.generation !== original.generation) return { status: "cancelled" } as FileSaveResult
      onComplete?.(receipt)
      return receipt
    } catch (error) {
      return isAbortError(error) || isCancelledError(error) ? { status: "cancelled" } as FileSaveResult : { status: "error", message: "Couldn’t save this file" } as FileSaveResult
    }
  }, [view, owner, target])
  const cancel = useCallback(() => { void cancelFileDownload(owner, fileDownloadKey(owner, target)).catch(() => undefined) }, [owner, target])
  return { state, start, cancel }
}
export function resetFileDownloadsForTest(owner: ApplicationOwner): void {
  void owner.queryClient.cancelQueries({ queryKey: applicationKey(owner, "file-download") })
  owner.queryClient.removeQueries({ queryKey: applicationKey(owner, "file-download") })
}
