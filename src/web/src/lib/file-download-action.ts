"use client"

import { toast } from "sonner"
import { captureApplicationOwner, assertApplicationOwner, type ApplicationOwner } from "./application-owner"
import { cancelFileDownload, fileDownloadKey, fileDownloadStatusText, readFileDownloadState, startFileDownload } from "./file-download"

export async function downloadFileWithFeedback(owner: ApplicationOwner, target: { url: string; name: string }, options: { signal?: AbortSignal; assertActive: () => void }): Promise<void> {
  const token = captureApplicationOwner(owner)
  const assert = () => { assertApplicationOwner(token, options.signal); options.assertActive() }
  try { assert() } catch { return }
  const key = fileDownloadKey(owner, target)
  if (readFileDownloadState(owner, key).status === "downloading") {
    await cancelFileDownload(owner, key).catch(() => undefined)
    return
  }
  const id = toast.loading("Downloading…", {
    action: { label: "Cancel", onClick: () => { try { assert(); void cancelFileDownload(owner, key).catch(() => undefined) } catch {} } },
  })
  let result
  try { result = await startFileDownload(owner, target, options.signal); assert() }
  catch { return }
  finally { toast.dismiss(id) }
  const text = fileDownloadStatusText(result)
  if (result.status === "error") toast.error(text, {
    action: { label: "Retry", onClick: () => { try { assert(); void downloadFileWithFeedback(owner, target, options) } catch {} } },
  })
  else if (result.status === "saved" || result.status === "started") toast.success(text)
}
