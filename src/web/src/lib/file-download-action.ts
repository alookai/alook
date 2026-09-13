"use client"

import { toast } from "sonner"
import { cancelFileDownload, fileDownloadKey, fileDownloadStatusText, readFileDownloadState, startFileDownload } from "./file-download"

export async function downloadFileWithFeedback(target: { url: string; name: string }): Promise<void> {
  const key = fileDownloadKey(target)
  if (readFileDownloadState(key).status === "downloading") {
    cancelFileDownload(key)
    return
  }
  const id = toast.loading("Downloading…", {
    action: { label: "Cancel", onClick: () => cancelFileDownload(key) },
  })
  await startFileDownload(target)
  toast.dismiss(id)
  const result = readFileDownloadState(key)
  const text = fileDownloadStatusText(result)
  if (result.status === "error") toast.error(text, {
    action: { label: "Retry", onClick: () => { void downloadFileWithFeedback(target) } },
  })
  else if (result.status === "saved" || result.status === "started") toast.success(text)
}
