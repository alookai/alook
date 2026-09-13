"use client"

import { useCallback } from "react"
import type { Artifact } from "@alook/shared"
import { getArtifactUrl, isPreviewable } from "./artifact-content-renderer"
import { downloadFileWithFeedback } from "@/lib/file-download-action"

export function useArtifactClick(workspaceId: string, preview: (artifact: Artifact) => void, image?: (artifact: Artifact) => void) {
  return useCallback((artifact: Artifact) => {
    if (image && artifact.content_type.startsWith("image/")) image(artifact)
    else if (isPreviewable(artifact)) preview(artifact)
    else void downloadFileWithFeedback({ url: getArtifactUrl(artifact.id, workspaceId, true), name: artifact.filename })
  }, [workspaceId, preview, image])
}
