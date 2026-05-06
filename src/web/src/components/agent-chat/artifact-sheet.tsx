"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetBody,
} from "@/components/ui/sheet";
import type { Artifact } from "@alook/shared";
import { FileText, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArtifactContentRenderer, getArtifactUrl } from "@/components/artifact-content-renderer";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ArtifactSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifacts: Artifact[];
  workspaceId: string;
  initialArtifact?: Artifact | null;
}

const MIN_WIDTH = 320;
const MAX_WIDTH_RATIO = 0.8;
const DEFAULT_WIDTH = 448;

export function ArtifactSheet({ open, onOpenChange, artifacts, workspaceId, initialArtifact = null }: ArtifactSheetProps) {
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragging = useRef(false);

  useEffect(() => {
    if (open && initialArtifact) {
      setSelectedArtifact(initialArtifact);
    }
  }, [open, initialArtifact]);

  const handleOpenChange = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      // Defer clearing selected artifact until sheet closing animation completes
      setTimeout(() => setSelectedArtifact(null), 300);
    }
  };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const maxW = window.innerWidth * MAX_WIDTH_RATIO;
    setWidth(Math.min(maxW, Math.max(MIN_WIDTH, window.innerWidth - e.clientX)));
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        style={{ width: `min(${width}px, 100vw)`, maxWidth: "none" }}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border"
      >
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="hidden sm:block absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-primary/20 active:bg-primary/30 transition-colors rounded-l-xl"
        />
        {selectedArtifact ? (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <SheetTitle className="truncate flex-1">{selectedArtifact.filename}</SheetTitle>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={() => window.open(getArtifactUrl(selectedArtifact.id, workspaceId, true), "_blank")}
                >
                  <Download className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 sm:hidden"
                  onClick={() => handleOpenChange(false)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </SheetHeader>
            <SheetBody className="thin-scrollbar">
              <ArtifactContentRenderer artifact={selectedArtifact} workspaceId={workspaceId} />
            </SheetBody>
          </>
        ) : (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <SheetTitle className="flex-1">Artifacts</SheetTitle>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 sm:hidden"
                  onClick={() => handleOpenChange(false)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </SheetHeader>
            <SheetBody className="thin-scrollbar">
              {artifacts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No artifacts uploaded yet.
                </p>
              ) : (
                <div className="space-y-1">
                  {artifacts.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setSelectedArtifact(a)}
                      className="flex items-start gap-3 w-full rounded-lg px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
                    >
                      <FileText className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{a.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatSize(a.size)} &middot; {new Date(a.created_at).toLocaleString()}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
