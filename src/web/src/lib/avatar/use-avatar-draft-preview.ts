"use client"

import { useEffect } from "react"
import type { AvatarDraft } from "./model"

export function useAvatarDraftPreview(draft: AvatarDraft) {
  const previewUrl = draft.kind === "photo" && draft.previewUrl.startsWith("blob:")
    ? draft.previewUrl
    : null

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])
}
