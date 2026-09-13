"use client"

import { toast } from "sonner"
import { readFileDownloadState, fileDownloadKey } from "@/lib/file-download"
import type { ComponentProps } from "react"
import { fileDownloadStatusText, useFileDownload } from "@/lib/file-download"

export function FileDownloadButton({ url, filename, children, onClick, ...props }: Omit<ComponentProps<"button">, "type"> & { url: string; filename: string }) {
  const download = useFileDownload({ url, name: filename })
  const message = fileDownloadStatusText(download.state)
  const busy = download.state.status === "downloading"
  return (
    <button
      {...props}
      type="button"
      aria-label={busy ? `Cancel download ${filename}` : props["aria-label"] ?? `Download ${filename}`}
      title={message ?? props.title}
      onClick={event => {
        onClick?.(event)
        if (event.defaultPrevented) return
        if (busy) download.cancel()
        else void download.start().then(() => {
          const result = readFileDownloadState(fileDownloadKey({ name: filename, url }))
          const text = fileDownloadStatusText(result)
          if (result.status === "error") toast.error(text)
          else if (result.status === "saved" || result.status === "started") toast.success(text)
        })
      }}
    >
      {children}
      <span role="status" className="sr-only">{message}</span>
    </button>
  )
}
