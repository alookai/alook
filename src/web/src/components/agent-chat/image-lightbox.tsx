"use client";

import React, { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Artifact } from "@alook/shared";
import { X, Download } from "lucide-react";
import { getArtifactUrl } from "@/components/artifact-content-renderer";

export function ImageLightbox({
  open,
  onClose,
  artifact,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  artifact: Artifact | null;
  workspaceId: string;
}) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, handleKeyDown]);

  if (!open || !artifact) return null;

  const fullUrl = getArtifactUrl(artifact.id, workspaceId);
  const downloadUrl = getArtifactUrl(artifact.id, workspaceId, true);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <a
          href={downloadUrl}
          download={artifact.filename}
          onClick={(e) => e.stopPropagation()}
          className="rounded-full p-2 text-white/70 hover:text-white hover:bg-white/10 transition-colors"
        >
          <Download className="size-5" />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-2 text-white/70 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="size-5" />
        </button>
      </div>
      <img
        src={fullUrl}
        alt={artifact.filename}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
      />
    </div>,
    document.body,
  );
}
