import { useCallback, useEffect, useRef, useState } from "react"
import type { ApplicationOwner } from "@/lib/application-owner"
import {
  readHtmlPreviewHeight,
  readHtmlPreviewMemoryHeight,
  saveHtmlPreviewHeight,
  writeHtmlPreviewMemoryHeight,
} from "@/lib/community/html-preview-height-cache"

const DEFAULT_HTML_PREVIEW_HEIGHT = 320

export function useHtmlPreviewHeight(
  owner: ApplicationOwner,
  attachmentId: string,
  attachmentUrl: string,
) {
  const cachedSync = readHtmlPreviewMemoryHeight(owner.queryClient, attachmentId)
  const [height, setHeight] = useState<number>(() => cachedSync ?? DEFAULT_HTML_PREVIEW_HEIGHT)
  const measuredLiveRef = useRef(false)

  useEffect(() => {
    if (cachedSync !== undefined || !owner.userId) return
    let active = true
    void readHtmlPreviewHeight(owner.userId, attachmentId, attachmentUrl).then((persisted) => {
      if (!active || measuredLiveRef.current || persisted === null) return
      const clamped = writeHtmlPreviewMemoryHeight(owner.queryClient, attachmentId, persisted)
      setHeight(clamped)
    })
    return () => { active = false }
  }, [attachmentId, attachmentUrl, cachedSync, owner.queryClient, owner.userId])

  const recordHeight = useCallback((rawHeight: number) => {
    measuredLiveRef.current = true
    const clamped = writeHtmlPreviewMemoryHeight(owner.queryClient, attachmentId, rawHeight)
    setHeight(clamped)
    void saveHtmlPreviewHeight(owner.userId, attachmentId, attachmentUrl, clamped)
  }, [attachmentId, attachmentUrl, owner.queryClient, owner.userId])

  return { height, recordHeight }
}
