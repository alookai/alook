"use client";

import React, { useState, useEffect } from "react";
import { useSheetResize, SheetResizeHandle } from "@/components/ui/sheet-resize-handle";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetBody,
} from "@/components/ui/sheet";
import type { Artifact } from "@alook/shared";
import { FileText, Download, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArtifactContentRenderer, getArtifactUrl, isHtmlType } from "@/components/artifact-content-renderer";
import { cn } from "@/lib/utils";

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
  versionMap: Map<string, number>;
  duplicateFilenames: Set<string>;
}

const MIN_WIDTH = 320;
const MAX_WIDTH_RATIO = 0.8;
const DEFAULT_WIDTH = 448;

export function ArtifactSheet({ open, onOpenChange, artifacts, workspaceId, initialArtifact = null, versionMap, duplicateFilenames }: ArtifactSheetProps) {
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const { width, onPointerDown, onPointerMove, onPointerUp } = useSheetResize({
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidthRatio: MAX_WIDTH_RATIO,
  });

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


  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        style={{ width: `min(${width}px, 100vw)`, maxWidth: "none" }}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border"
      >
        <SheetResizeHandle onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
        {selectedArtifact ? (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 sm:hidden"
                  onClick={() => handleOpenChange(false)}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <SheetTitle className="truncate flex-1">
                  {selectedArtifact.filename}
                  {duplicateFilenames.has(selectedArtifact.filename) && (
                    <span className="ml-2 text-xs text-muted-foreground bg-muted rounded-full px-2 py-1 font-normal">
                      v{versionMap.get(selectedArtifact.id) ?? 1}
                    </span>
                  )}
                </SheetTitle>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={() => window.open(getArtifactUrl(selectedArtifact.id, workspaceId, true), "_blank")}
                >
                  <Download className="size-4" />
                </Button>
              </div>
            </SheetHeader>
            <SheetBody className={cn(
              "thin-scrollbar",
              isHtmlType(selectedArtifact.content_type) && "p-0! overflow-hidden!"
            )}>
              <ArtifactContentRenderer artifact={selectedArtifact} workspaceId={workspaceId} />
            </SheetBody>
          </>
        ) : (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 sm:hidden"
                  onClick={() => handleOpenChange(false)}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <SheetTitle className="flex-1">Artifacts</SheetTitle>
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
                      className="flex items-center gap-3 w-full rounded-lg px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">
                          {a.filename}
                          {duplicateFilenames.has(a.filename) && (
                            <span className="ml-2 text-xs text-muted-foreground bg-muted rounded-full px-2 py-1 font-normal">
                              v{versionMap.get(a.id) ?? 1}
                            </span>
                          )}
                        </p>
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
