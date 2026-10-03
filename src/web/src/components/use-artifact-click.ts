"use client"

import { useCallback } from "react"
import type { Artifact } from "@alook/shared"
import { getArtifactUrl, isPreviewable } from "./artifact-content-renderer"
import { downloadFileWithFeedback } from "@/lib/file-download-action"
import { useWorkspaceOwner } from "@/contexts/workspace-context"
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source"

export function useArtifactClick(workspaceId: string, preview: (artifact: Artifact) => void, image?: (artifact: Artifact) => void, identity = "artifact-click") {
  const owner = useWorkspaceOwner()
  const source = useWorkspaceViewSource(owner, identity, true)
  return useCallback((artifact: Artifact) => {
    source.assertActive()
    if (image && artifact.content_type.startsWith("image/")) image(artifact)
    else if (isPreviewable(artifact)) preview(artifact)
    else void downloadFileWithFeedback(owner.application, { url: getArtifactUrl(artifact.id, workspaceId, true), name: artifact.filename }, { signal: source.signal, assertActive: source.assertActive })
  }, [source, image, preview, owner.application, workspaceId])
}
