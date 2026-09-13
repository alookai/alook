"use client"

import type { Artifact } from "@alook/shared";
import { File as FileIcon } from "lucide-react";
import { FileDownloadButton } from "@/components/file-download-button";
import { isPreviewable, getArtifactUrl } from "@/components/artifact-content-renderer";
import { formatSize } from "@/components/agent-chat/artifact-sheet";
import { cn } from "@/lib/utils";

export function IssueAttachmentList({ artifacts, workspaceId, onArtifactClick }: { artifacts: Artifact[]; workspaceId: string; onArtifactClick?: (artifact: Artifact) => void }) {
  if (artifacts.length === 0) return null;
  const baseCls = "flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent";
  return (
    <div className="space-y-1">
      {artifacts.map((artifact) => {
        const canPreview = onArtifactClick && isPreviewable(artifact);
        const inner = (
          <>
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{artifact.filename}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatSize(artifact.size)}</span>
          </>
        );
        return canPreview ? (
          <button
            key={artifact.id}
            type="button"
            onClick={() => onArtifactClick(artifact)}
            className={cn(baseCls, "w-full text-left")}
          >
            {inner}
          </button>
        ) : (
          <FileDownloadButton
            key={artifact.id}
            url={getArtifactUrl(artifact.id, workspaceId, true)}
            filename={artifact.filename}
            className={baseCls}
          >
            {inner}
          </FileDownloadButton>
        );
      })}
    </div>
  );
}
