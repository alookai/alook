import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { generateThumbnail } from "../lib/image-thumbnail";

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export type PendingFile = {
  file: File;
  thumbnailUrl: string | null;
  thumbnailBlob: Blob | null;
  width?: number;
  height?: number;
};

export type UseFileAttachmentsOptions = {
  /** Per-file byte ceiling. Defaults to 10 MB. */
  maxFileSize?: number;
};

function revokeThumbnailUrls(files: PendingFile[]) {
  for (const pf of files) {
    if (pf.thumbnailUrl) URL.revokeObjectURL(pf.thumbnailUrl);
  }
}

export function useFileAttachments(opts: UseFileAttachmentsOptions = {}) {
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  // Options are read via ref so `addPendingFiles`'s stable identity survives
  // caller re-renders while still observing an updated size limit.
  const optsRef = useRef({ maxFileSize });
  useEffect(() => {
    optsRef.current = { maxFileSize };
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
    const { maxFileSize: maxSize } = optsRef.current;
    const valid: File[] = [];
    for (const file of files) {
      if (file.size > maxSize) {
        const mb = Math.floor(maxSize / 1024 / 1024);
        toast.error(`"${file.name}" exceeds ${mb} MB limit`);
        continue;
      }
      valid.push(file);
    }
    if (valid.length === 0) return;

    const pending: PendingFile[] = await Promise.all(
      valid.map(async (file) => {
        const thumbnail = await generateThumbnail(file);
        const thumbnailUrl = thumbnail ? URL.createObjectURL(thumbnail.blob) : null;
        return {
          file,
          thumbnailUrl,
          thumbnailBlob: thumbnail?.blob ?? null,
          width: thumbnail?.width,
          height: thumbnail?.height,
        };
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
