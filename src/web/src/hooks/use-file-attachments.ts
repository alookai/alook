import { createStore, useCreateStore, useSelector } from "@tanstack/react-store";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useLayoutEffect, useRef, useMemo } from "react";
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

const draftIdentity = createStore(0);
function createDraftId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  draftIdentity.setState((value) => value + 1);
  return `attachment-draft-${draftIdentity.get()}`;
}
function revokeThumbnailUrls(files: readonly PendingFile[]) { for (const file of files) if (file.thumbnailUrl) URL.revokeObjectURL(file.thumbnailUrl); }

export function useFileAttachments(opts: UseFileAttachmentsOptions = {}) {
  const client = useQueryClient();
  const id = useMemo(() => createDraftId(), []);
  const key = useMemo(() => ["application", "attachment-preparation", id], [id]);
  const protocol = useCreateStore({ files: [] as PendingFile[], queued: new Map<string, number>() as ReadonlyMap<string, number>, generation: 0, active: true, controller: new AbortController(), dragging: false, dragDepth: 0, options: { maxFileSize: opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE, maxFiles: opts.maxFiles, policy: opts.thumbnailPolicy ?? "legacy", scope: opts.draftSessionScope } });
  const pendingFiles = useSelector(protocol, (state) => state.files);
  const dragging = useSelector(protocol, (state) => state.dragging);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    protocol.setState((state) => ({ ...state, options: { maxFileSize: opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE, maxFiles: opts.maxFiles, policy: opts.thumbnailPolicy ?? "legacy", scope: opts.draftSessionScope } }));
  }, [opts.maxFileSize, opts.maxFiles, opts.thumbnailPolicy, opts.draftSessionScope, protocol]);
  useLayoutEffect(() => {
    protocol.setState((state) => ({ ...state, active: true, controller: state.controller.signal.aborted ? new AbortController() : state.controller, files: state.files.map((file) => file.thumbnailBlob && !file.thumbnailUrl ? { ...file, thumbnailUrl: URL.createObjectURL(file.thumbnailBlob) } : file) }));
    const original = protocol.get().controller;
    return () => {
      original.abort();
      revokeThumbnailUrls(protocol.get().files);
      protocol.setState((state) => ({ ...state, active: false, generation: state.generation + 1, queued: new Map(), files: state.files.map((file) => ({ ...file, thumbnailUrl: null })) }));
    };
  }, [protocol]);
  type Preparation = { drafts: readonly AttachmentDraftFile[]; generation: number; policy: "legacy" | "community"; scope?: string; signal: AbortSignal };
  const preparation = useMutation({ meta: { observabilityAction: "attachment.prepare" }, mutationKey: key, scope: { id }, gcTime: 0,
    mutationFn: async ({ drafts, generation, policy, scope, signal }: Preparation) => {
      const eligible = () => protocol.get().active && protocol.get().generation === generation && !signal.aborted;
      if (!eligible()) return;
      const prepared = await Promise.all(drafts.map(async ({ draftId, file }): Promise<PendingFile | null> => {
        try {
          const thumbnail = await new Promise<Awaited<ReturnType<typeof prepareCommunityImage>>>((resolve, reject) => {
            const decoding = new AbortController();
            const abort = () => { decoding.abort(); cleanup(); reject(new DOMException("Retired attachment preparation", "AbortError")); };
            const timer = setTimeout(() => { decoding.abort(); cleanup(); reject(new Error("Image preparation timed out")); }, 30_000);
            const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) { abort(); return; }
            void (policy === "community" ? prepareCommunityImage(file, decoding.signal) : generateThumbnail(file, decoding.signal)).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
          });
          if (!eligible()) return null;
          const blob = thumbnail?.blob ?? null;
          const preview = blob ?? (policy === "community" && thumbnail ? file : null);
          return { draftId, file, thumbnailUrl: preview ? URL.createObjectURL(preview) : null, thumbnailBlob: blob, width: thumbnail?.width, height: thumbnail?.height };
        } catch {
          if (eligible()) { toast.error(`Could not prepare "${file.name}" for upload`); if (scope) removeComposerAttachmentSessionFiles(scope, [draftId]); }
          return null;
        }
      }));
      const pending = prepared.filter((file): file is PendingFile => file !== null);
      if (!eligible()) { revokeThumbnailUrls(pending); return; }
      protocol.setState((state) => {
        const queued = new Map(state.queued);
        for (const { draftId } of drafts) if (queued.get(draftId) === generation) queued.delete(draftId);
        const ids = new Set(state.files.map((file) => file.draftId));
        const unique = pending.filter((file) => !ids.has(file.draftId));
        revokeThumbnailUrls(pending.filter((file) => ids.has(file.draftId)));
        return { ...state, queued, files: [...state.files, ...unique] };
      });
    },
  });
  const mutatePreparation = preparation.mutateAsync;
  const queuePreparation = useCallback((drafts: readonly AttachmentDraftFile[], generation: number, policy: "legacy" | "community", scope?: string) => mutatePreparation({ drafts, generation, policy, scope, signal: protocol.get().controller.signal }), [mutatePreparation, protocol]);
  const setPendingFiles = useCallback((next: PendingFile[] | ((previous: PendingFile[]) => PendingFile[])) => {
    const state = protocol.get();
    const files = typeof next === "function" ? next(state.files) : next;
    if (!files.length) { state.controller.abort(); if (state.options.scope) clearComposerAttachmentSession(state.options.scope); revokeThumbnailUrls(state.files); }
    protocol.setState((current) => ({ ...current, files, ...(!files.length ? { generation: current.generation + 1, queued: new Map(), controller: new AbortController() } : {}) }));
  }, [protocol]);
  const transferPendingFiles = useCallback(() => {
    const state = protocol.get();
    state.controller.abort();
    if (state.options.scope) transferComposerAttachmentSession(state.options.scope);
    protocol.setState((current) => ({ ...current, files: [], generation: current.generation + 1, queued: new Map(), controller: new AbortController() }));
    return state.files;
  }, [protocol]);
  const addPendingFiles = useCallback(async (files: File[]) => {
    const state = protocol.get();
    if (!state.active) return;
    const { maxFileSize, maxFiles, policy, scope } = state.options;
    const valid = files.filter((file) => {
      if (file.size <= maxFileSize) return true;
      toast.error(`"${file.name}" exceeds ${Math.floor(maxFileSize / 1024 / 1024)} MB limit`); return false;
    });
    if (!valid.length) return;
    if (maxFiles !== undefined && state.files.length + state.queued.size + valid.length > maxFiles) { toast.error(`You can attach up to ${maxFiles} files`); return; }
    const drafts = valid.map((file) => ({ draftId: createDraftId(), file }));
    if (scope) {
      const result = appendComposerAttachmentSession(scope, drafts);
      if (result.evictedScopes > 0) toast.info("Older attachment drafts were cleared to free memory");
      if (!result.accepted) { toast.error("These files exceed the attachment draft memory limit"); return; }
    }
    protocol.setState((current) => ({ ...current, queued: new Map([...current.queued, ...drafts.map((draft) => [draft.draftId, state.generation] as const)]) }));
    await queuePreparation(drafts, state.generation, policy, scope);
  }, [protocol, queuePreparation]);
  const restorePendingFiles = useCallback(async (drafts: readonly AttachmentDraftFile[]) => {
    const previous = protocol.get();
    previous.controller.abort();
    revokeThumbnailUrls(previous.files);
    protocol.setState((state) => ({ ...state, files: [], generation: state.generation + 1, queued: new Map(), controller: new AbortController() }));
    const state = protocol.get(), { maxFiles, policy, scope } = state.options;
    const accepted = maxFiles === undefined ? drafts : drafts.slice(0, maxFiles);
    protocol.setState((current) => ({ ...current, queued: new Map(accepted.map((draft) => [draft.draftId, state.generation])) }));
    if (accepted.length) await queuePreparation(accepted, state.generation, policy, scope);
  }, [protocol, queuePreparation]);
  useLayoutEffect(() => {
    if ((opts.thumbnailPolicy ?? "legacy") !== "community") return;
    void restorePendingFiles(opts.draftSessionScope ? readComposerAttachmentSession(opts.draftSessionScope) : []).catch(() => undefined);
  }, [opts.draftSessionScope, opts.thumbnailPolicy, restorePendingFiles]);
  const awaitPendingFiles = useCallback(async (): Promise<readonly PendingFile[]> => {
    const original = protocol.get(), assert = () => {
      if (!protocol.get().active || protocol.get().generation !== original.generation) throw new DOMException("Retired attachment preparation", "AbortError");
    };
    assert();
    await new Promise<void>((resolve, reject) => {
      let release: () => void = () => undefined;
      const finish = () => {
        try { assert(); } catch (error) { cleanup(); reject(error); return; }
        if (!client.getMutationCache().findAll({ mutationKey: key, status: "pending" }).length) { cleanup(); resolve(); }
      };
      const cleanup = () => { release(); original.controller.signal.removeEventListener("abort", finish); };
      release = client.getMutationCache().subscribe(finish);
      original.controller.signal.addEventListener("abort", finish, { once: true });
      finish();
    });
    assert(); return protocol.get().files;
  }, [client, key, protocol]);
  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => { if (event.target.files) void addPendingFiles(Array.from(event.target.files)).catch(() => undefined); event.target.value = ""; }, [addPendingFiles]);
  const removePendingFile = useCallback((index: number) => {
    const state = protocol.get(), removed = state.files[index];
    if (removed?.draftId && state.options.scope) removeComposerAttachmentSessionFiles(state.options.scope, [removed.draftId]);
    if (removed?.thumbnailUrl) URL.revokeObjectURL(removed.thumbnailUrl);
    protocol.setState((current) => ({ ...current, files: current.files.filter((_, item) => item !== index) }));
  }, [protocol]);
  const handleDragEnter = useCallback((event: React.DragEvent) => { event.preventDefault(); event.stopPropagation(); protocol.setState((state) => ({ ...state, dragDepth: state.dragDepth + 1, dragging: state.dragging || event.dataTransfer.types.includes("Files") })); }, [protocol]);
  const handleDragLeave = useCallback((event: React.DragEvent) => { event.preventDefault(); event.stopPropagation(); protocol.setState((state) => ({ ...state, dragDepth: Math.max(0, state.dragDepth - 1), dragging: state.dragDepth > 1 && state.dragging })); }, [protocol]);
  const handleDragOver = useCallback((event: React.DragEvent) => { event.preventDefault(); event.stopPropagation(); }, []);
  const handleDrop = useCallback((event: React.DragEvent) => { event.preventDefault(); event.stopPropagation(); protocol.setState((state) => ({ ...state, dragging: false, dragDepth: 0 })); void addPendingFiles(Array.from(event.dataTransfer.files)).catch(() => undefined); }, [addPendingFiles, protocol]);
  return { pendingFiles, readPendingFiles: () => protocol.get().files, setPendingFiles, transferPendingFiles, restorePendingFiles, awaitPendingFiles, fileInputRef, addPendingFiles, handleFileSelect, removePendingFile, dragging, handleDragEnter, handleDragLeave, handleDragOver, handleDrop };
}
