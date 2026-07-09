import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { generateThumbnail } from "../lib/image-thumbnail";

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export type PendingFile = {
  file: File;
  thumbnailUrl: string | null;
  thumbnailBlob: Blob | null;
};

export type UseFileAttachmentsOptions = {
  /** Per-file byte ceiling. Defaults to 10 MB. */
  maxFileSize?: number;
  /**
   * Whitelist of allowed MIME prefixes. An entry ending in `/` (e.g.
   * `"image/"`) matches any MIME with that prefix; otherwise the full
   * MIME string must match exactly (e.g. `"application/pdf"`). When
   * unset, all MIMEs are accepted — that's the historical behavior. Pass
   * the server-side allowlist here so drag-drop AND file-picker paths
   * both reject unsupported types at the client boundary instead of
   * failing on upload.
   */
  allowedMimePrefixes?: readonly string[];
};

function revokeThumbnailUrls(files: PendingFile[]) {
  for (const pf of files) {
    if (pf.thumbnailUrl) URL.revokeObjectURL(pf.thumbnailUrl);
  }
}

/**
 * MIME allowlist check. Mirrors the server-side `mimeAllowed` in
 * `src/web/src/lib/community/upload.ts`: an allowlist entry ending in `/`
 * (e.g. `"image/"`) matches any MIME with that prefix; otherwise the full
 * MIME string must match exactly (e.g. `"application/pdf"`). Exported for
 * unit tests — do not depend on it from outside this file.
 */
export function isMimeAllowed(contentType: string, allowed: readonly string[]): boolean {
  if (!contentType) return false;
  return allowed.some((entry) =>
    entry.endsWith("/") ? contentType.startsWith(entry) : contentType === entry,
  );
}

export function useFileAttachments(opts: UseFileAttachmentsOptions = {}) {
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const allowedMimePrefixes = opts.allowedMimePrefixes;
  // Options are read via ref so `addPendingFiles`'s stable identity survives
  // caller re-renders — callers pass the constant array from shared
  // constants but the reference identity isn't guaranteed after HMR.
  const optsRef = useRef({ maxFileSize, allowedMimePrefixes });
  useEffect(() => {
    optsRef.current = { maxFileSize, allowedMimePrefixes };
  });
  const [pendingFiles, _setPendingFiles] = useState<PendingFile[]>([]);
  const pendingFilesRef = useRef(pendingFiles);
  useEffect(() => {
    pendingFilesRef.current = pendingFiles;
  });

  const setPendingFiles = useCallback((next: PendingFile[] | ((prev: PendingFile[]) => PendingFile[])) => {
    _setPendingFiles((prev) => {
      const nextVal = typeof next === "function" ? next(prev) : next;
      if (nextVal.length === 0 && prev.length > 0) {
        revokeThumbnailUrls(prev);
      }
      return nextVal;
    });
  }, []);

  useEffect(() => {
    return () => revokeThumbnailUrls(pendingFilesRef.current);
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const addPendingFiles = useCallback(async (files: File[]) => {
    const { maxFileSize: maxSize, allowedMimePrefixes: allowed } = optsRef.current;
    const valid: File[] = [];
    for (const file of files) {
      if (file.size > maxSize) {
        const mb = Math.floor(maxSize / 1024 / 1024);
        toast.error(`"${file.name}" exceeds ${mb} MB limit`);
        continue;
      }
      if (allowed && !isMimeAllowed(file.type, allowed)) {
        toast.error(`"${file.name}" — file type not allowed`);
        continue;
      }
      valid.push(file);
    }
    if (valid.length === 0) return;

    const pending: PendingFile[] = await Promise.all(
      valid.map(async (file) => {
        const blob = await generateThumbnail(file);
        const thumbnailUrl = blob ? URL.createObjectURL(blob) : null;
        return { file, thumbnailUrl, thumbnailBlob: blob };
      }),
    );

    _setPendingFiles((prev) => [...prev, ...pending]);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList) return;
      addPendingFiles(Array.from(fileList));
      e.target.value = "";
    },
    [addPendingFiles],
  );

  const removePendingFile = useCallback((index: number) => {
    _setPendingFiles((prev) => {
      const removed = prev[index];
      if (removed?.thumbnailUrl) URL.revokeObjectURL(removed.thumbnailUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      dragCounter.current = 0;
      addPendingFiles(Array.from(e.dataTransfer.files));
    },
    [addPendingFiles],
  );

  return {
    pendingFiles,
    setPendingFiles,
    fileInputRef,
    addPendingFiles,
    handleFileSelect,
    removePendingFile,
    dragging,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  };
}
