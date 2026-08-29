import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { generateThumbnail, prepareCommunityImage } from "../lib/image-thumbnail";
import {
  appendComposerAttachmentSession,
  clearComposerAttachmentSession,
  readComposerAttachmentSession,
  removeComposerAttachmentSessionFiles,
  transferComposerAttachmentSession,
} from "../lib/community/composer-attachment-session";

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export type PendingFile = {
  /** Stable for the lifetime of a same-tab Community attachment draft. */
  draftId?: string;
  file: File;
  thumbnailUrl: string | null;
  thumbnailBlob: Blob | null;
  width?: number;
  height?: number;
};

export type AttachmentDraftFile = {
  draftId: string;
  file: File;
};

export type UseFileAttachmentsOptions = {
  /** Per-file byte ceiling. Defaults to 10 MB. */
  maxFileSize?: number;
  /** Optional count ceiling. Generic consumers remain unbounded by default. */
  maxFiles?: number;
  thumbnailPolicy?: "legacy" | "community";
  /** Enables same-tab Community draft restoration for this canonical scope. */
  draftSessionScope?: string;
};

let fallbackDraftId = 0;

function createDraftId() {
  return globalThis.crypto?.randomUUID?.() ?? `attachment-draft-${++fallbackDraftId}`;
}

function revokeThumbnailUrls(files: PendingFile[]) {
  for (const pf of files) {
    if (pf.thumbnailUrl) URL.revokeObjectURL(pf.thumbnailUrl);
  }
}

export function useFileAttachments(opts: UseFileAttachmentsOptions = {}) {
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxFiles = opts.maxFiles;
  const thumbnailPolicy = opts.thumbnailPolicy ?? "legacy";
  // Options are read via ref so `addPendingFiles`'s stable identity survives
  // caller re-renders while still observing an updated size limit.
  const optsRef = useRef({
    maxFileSize,
    maxFiles,
    thumbnailPolicy,
    draftSessionScope: opts.draftSessionScope,
  });
  useLayoutEffect(() => {
    optsRef.current = {
      maxFileSize,
      maxFiles,
      thumbnailPolicy,
      draftSessionScope: opts.draftSessionScope,
    };
  });
  const [pendingFiles, _setPendingFiles] = useState<PendingFile[]>([]);
  const pendingFilesRef = useRef(pendingFiles);
  const preparationTailRef = useRef<Promise<void>>(Promise.resolve());
  const preparationGenerationRef = useRef(0);
  const queuedDraftGenerationsRef = useRef(new Map<string, number>());
  const mountedRef = useRef(true);

  const setPendingFiles = useCallback((next: PendingFile[] | ((prev: PendingFile[]) => PendingFile[])) => {
    const prev = pendingFilesRef.current;
    const nextVal = typeof next === "function" ? next(prev) : next;
    if (nextVal.length === 0) {
      if (optsRef.current.draftSessionScope) {
        clearComposerAttachmentSession(optsRef.current.draftSessionScope);
      }
      preparationGenerationRef.current++;
      queuedDraftGenerationsRef.current.clear();
      if (prev.length > 0) revokeThumbnailUrls(prev);
    }
    pendingFilesRef.current = nextVal;
    _setPendingFiles(nextVal);
  }, []);

  const transferPendingFiles = useCallback(() => {
    const transferred = pendingFilesRef.current;
    if (optsRef.current.draftSessionScope) {
      transferComposerAttachmentSession(optsRef.current.draftSessionScope);
    }
    preparationGenerationRef.current++;
    queuedDraftGenerationsRef.current.clear();
    pendingFilesRef.current = [];
    _setPendingFiles([]);
    return transferred;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      revokeThumbnailUrls(pendingFilesRef.current);
    };
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const queuePreparation = useCallback(async (
    drafts: readonly AttachmentDraftFile[],
    generation: number,
    policy: "legacy" | "community",
    draftSessionScope: string | undefined,
  ) => {
    const prior = preparationTailRef.current;
    const preparation = prior.then(async () => {
      const prepared = await Promise.all(
        drafts.map(async ({ draftId, file }): Promise<PendingFile | null> => {
          if (policy === "community") {
            try {
              const image = await prepareCommunityImage(file);
              const previewSource = image?.blob ?? (image ? file : null);
              return {
                draftId,
                file,
                thumbnailUrl: previewSource ? URL.createObjectURL(previewSource) : null,
                thumbnailBlob: image?.blob ?? null,
                width: image?.width,
                height: image?.height,
              } satisfies PendingFile;
            } catch {
              if (mountedRef.current && preparationGenerationRef.current === generation) {
                toast.error(`Could not prepare "${file.name}" for upload`);
                if (draftSessionScope) {
                  removeComposerAttachmentSessionFiles(draftSessionScope, [draftId]);
                }
              }
              return null;
            }
          }
          const thumbnail = await generateThumbnail(file);
          const thumbnailUrl = thumbnail ? URL.createObjectURL(thumbnail.blob) : null;
          return {
            draftId,
            file,
            thumbnailUrl,
            thumbnailBlob: thumbnail?.blob ?? null,
            width: thumbnail?.width,
            height: thumbnail?.height,
          };
        }),
      );
      for (const { draftId } of drafts) {
        if (queuedDraftGenerationsRef.current.get(draftId) === generation) {
          queuedDraftGenerationsRef.current.delete(draftId);
        }
      }
      const pending = prepared.filter((file): file is PendingFile => file !== null);
      if (pending.length === 0) return;

      if (!mountedRef.current || preparationGenerationRef.current !== generation) {
        revokeThumbnailUrls(pending);
        return;
      }

      const currentIds = new Set(pendingFilesRef.current.map((file) => file.draftId));
      const next = [
        ...pendingFilesRef.current,
        ...pending.filter((file) => !currentIds.has(file.draftId)),
      ];
      pendingFilesRef.current = next;
      _setPendingFiles(next);
    });
    preparationTailRef.current = preparation.catch(() => {});
    await preparation;
  }, []);

  const addPendingFiles = useCallback(async (files: File[]) => {
    const {
      maxFileSize: maxSize,
      maxFiles: countLimit,
      thumbnailPolicy: policy,
      draftSessionScope,
    } = optsRef.current;
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

    const reservedCount = pendingFilesRef.current.length + queuedDraftGenerationsRef.current.size;
    if (countLimit !== undefined && reservedCount + valid.length > countLimit) {
      toast.error(`You can attach up to ${countLimit} files`);
      return;
    }

    const drafts = valid.map((file) => ({ draftId: createDraftId(), file }));
    if (draftSessionScope) {
      const result = appendComposerAttachmentSession(draftSessionScope, drafts);
      if (result.evictedScopes > 0) {
        toast.info("Older attachment drafts were cleared to free memory");
      }
      if (!result.accepted) {
        toast.error("These files exceed the attachment draft memory limit");
        return;
      }
    }
    const generation = preparationGenerationRef.current;
    for (const { draftId } of drafts) queuedDraftGenerationsRef.current.set(draftId, generation);
    await queuePreparation(
      drafts,
      generation,
      policy,
      draftSessionScope,
    );
  }, [queuePreparation]);

  const restorePendingFiles = useCallback(async (
    drafts: readonly AttachmentDraftFile[],
  ) => {
    const previous = pendingFilesRef.current;
    preparationGenerationRef.current++;
    const generation = preparationGenerationRef.current;
    queuedDraftGenerationsRef.current.clear();
    pendingFilesRef.current = [];
    _setPendingFiles([]);
    revokeThumbnailUrls(previous);

    const {
      maxFiles: countLimit,
      thumbnailPolicy: policy,
      draftSessionScope,
    } = optsRef.current;
    const accepted = countLimit === undefined ? drafts : drafts.slice(0, countLimit);
    for (const { draftId } of accepted) queuedDraftGenerationsRef.current.set(draftId, generation);
    if (accepted.length > 0) {
      await queuePreparation(accepted, generation, policy, draftSessionScope);
    }
  }, [queuePreparation]);

  useLayoutEffect(() => {
    if (thumbnailPolicy !== "community") return;
    const snapshot = opts.draftSessionScope
      ? readComposerAttachmentSession(opts.draftSessionScope)
      : [];
    void restorePendingFiles(snapshot);
  }, [opts.draftSessionScope, restorePendingFiles, thumbnailPolicy]);

  const awaitPendingFiles = useCallback(async (): Promise<readonly PendingFile[]> => {
    while (true) {
      const tail = preparationTailRef.current;
      await tail;
      if (tail === preparationTailRef.current) return pendingFilesRef.current;
    }
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
    const prev = pendingFilesRef.current;
    const removed = prev[index];
    if (removed?.draftId && optsRef.current.draftSessionScope) {
      removeComposerAttachmentSessionFiles(optsRef.current.draftSessionScope, [removed.draftId]);
    }
    if (removed?.thumbnailUrl) URL.revokeObjectURL(removed.thumbnailUrl);
    const next = prev.filter((_, i) => i !== index);
    pendingFilesRef.current = next;
    _setPendingFiles(next);
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
    transferPendingFiles,
    restorePendingFiles,
    awaitPendingFiles,
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
