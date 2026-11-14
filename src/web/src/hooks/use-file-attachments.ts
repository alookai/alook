import { createStore, useCreateStore, useSelector } from "@tanstack/react-store";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useLayoutEffect, useRef, useMemo } from "react";
import { toast } from "sonner";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_SIZE_BYTES, MAX_INLINE_IMAGE_SIZE_BYTES } from "@alook/shared";
import { readCommunityImageDimensions } from "../lib/image-metadata";
import { isInlineAttachmentContentType } from "../lib/community/attachment-content-type";
import {
  appendComposerAttachmentSession,
  clearComposerAttachmentSession,
  readComposerAttachmentSession,
  removeComposerAttachmentSessionFiles,
  transferComposerAttachmentSession,
} from "../lib/community/composer-attachment-session";

export type PendingFile = {
  /** Stable for the lifetime of a same-tab Community attachment draft. */
  draftId?: string;
  file: File;
  thumbnailUrl: string | null;
  preparing?: boolean;
  preparationFailed?: boolean;
  width?: number;
  height?: number;
};

export type AttachmentDraftFile = {
  draftId: string;
  file: File;
};

const draftIdentity = createStore(0);
function createDraftId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  draftIdentity.setState((value) => value + 1);
  return `attachment-draft-${draftIdentity.get()}`;
}
function revokeThumbnailUrls(files: readonly PendingFile[]) { for (const file of files) if (file.thumbnailUrl) URL.revokeObjectURL(file.thumbnailUrl); }
type PreparationLease = { generation: number; controller: AbortController };
function cancelPreparations(queued: ReadonlyMap<string, PreparationLease>) { for (const lease of queued.values()) lease.controller.abort(); }
function pendingDraft(draft: AttachmentDraftFile): PendingFile { return { ...draft, thumbnailUrl: null, preparing: true }; }

export function useFileAttachments(draftSessionScope?: string) {
  const client = useQueryClient();
  const id = useMemo(() => createDraftId(), []);
  const key = useMemo(() => ["application", "attachment-preparation", id], [id]);
  const protocol = useCreateStore({ files: [] as PendingFile[], queued: new Map<string, PreparationLease>() as ReadonlyMap<string, PreparationLease>, generation: 0, active: true, controller: new AbortController(), dragging: false, dragDepth: 0, scope: draftSessionScope });
  const pendingFiles = useSelector(protocol, (state) => state.files);
  const dragging = useSelector(protocol, (state) => state.dragging);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    protocol.setState((state) => ({ ...state, active: true, controller: state.controller.signal.aborted ? new AbortController() : state.controller, files: state.files.map((file) => {
      const preview = file.width !== undefined && file.height !== undefined ? file.file : null;
      return preview && !file.thumbnailUrl ? { ...file, thumbnailUrl: URL.createObjectURL(preview) } : file;
    }) }));
    return () => {
      protocol.get().controller.abort();
      cancelPreparations(protocol.get().queued);
      revokeThumbnailUrls(protocol.get().files);
      protocol.setState((state) => ({ ...state, active: false, generation: state.generation + 1, queued: new Map(), files: state.files.filter((file) => !file.preparing).map((file) => ({ ...file, thumbnailUrl: null })), dragging: false, dragDepth: 0 }));
    };
  }, [protocol]);
  type Preparation = { drafts: readonly AttachmentDraftFile[]; generation: number; signal: AbortSignal };
  const preparation = useMutation({ meta: { observabilityAction: "attachment.prepare" }, mutationKey: key, scope: { id }, gcTime: 0,
    mutationFn: async ({ drafts, generation, signal }: Preparation) => {
      const eligible = () => protocol.get().active && protocol.get().generation === generation && !signal.aborted;
      if (!eligible()) return;
      for (const { draftId, file } of drafts) {
        const lease = protocol.get().queued.get(draftId);
        const owns = () => eligible() && protocol.get().queued.get(draftId) === lease && !lease?.controller.signal.aborted;
        if (!lease || lease.generation !== generation || !owns()) continue;
        const fileSignal = lease.controller.signal;
        let prepared: PendingFile | null = null;
        try {
          const thumbnail = await new Promise<Awaited<ReturnType<typeof readCommunityImageDimensions>>>((resolve, reject) => {
            const decoding = new AbortController();
            const abort = () => { decoding.abort(); cleanup(); reject(new DOMException("Retired attachment preparation", "AbortError")); };
            const timer = setTimeout(() => { cleanup(); resolve(null); decoding.abort(); }, 30_000);
            const cleanup = () => { clearTimeout(timer); fileSignal.removeEventListener("abort", abort); };
            fileSignal.addEventListener("abort", abort, { once: true });
            if (fileSignal.aborted) { abort(); return; }
            void readCommunityImageDimensions(file, decoding.signal).then((value) => { cleanup(); resolve(value); }, (error) => {
              cleanup();
              if (fileSignal.aborted) reject(error);
              else resolve(null);
            });
          });
          if (!owns()) continue;
          const preview = thumbnail ? file : null;
          prepared = { draftId, file, thumbnailUrl: preview ? URL.createObjectURL(preview) : null, width: thumbnail?.width, height: thumbnail?.height };
        } catch {
          if (owns()) prepared = { draftId, file, thumbnailUrl: null };
        }
        if (!owns()) { if (prepared) revokeThumbnailUrls([prepared]); continue; }
        protocol.setState((state) => {
          const queued = new Map(state.queued);
          queued.delete(draftId);
          return { ...state, queued, files: state.files.flatMap((pending) => pending.draftId !== draftId ? [pending] : prepared ? [prepared] : []) };
        });
      }
    },
  });
  const mutatePreparation = preparation.mutateAsync;
  const queuePreparation = useCallback((drafts: readonly AttachmentDraftFile[], generation: number) => mutatePreparation({ drafts, generation, signal: protocol.get().controller.signal }), [mutatePreparation, protocol]);
  const clearPendingFiles = useCallback(() => {
    const state = protocol.get();
    state.controller.abort();
    cancelPreparations(state.queued);
    if (state.scope) clearComposerAttachmentSession(state.scope);
    revokeThumbnailUrls(state.files);
    protocol.setState((current) => ({ ...current, files: [], queued: new Map(), generation: current.generation + 1, controller: new AbortController() }));
  }, [protocol]);
  const transferPendingFiles = useCallback(() => {
    const state = protocol.get();
    state.controller.abort();
    cancelPreparations(state.queued);
    if (state.scope) transferComposerAttachmentSession(state.scope);
    protocol.setState((current) => ({ ...current, files: [], generation: current.generation + 1, queued: new Map(), controller: new AbortController() }));
    return state.files;
  }, [protocol]);
  const addPendingFiles = useCallback(async (files: File[]) => {
    const state = protocol.get();
    if (!state.active) return;
    const { scope } = state;
    const valid = files.filter((file) => {
      if (isInlineAttachmentContentType(file.type) && file.size > MAX_INLINE_IMAGE_SIZE_BYTES) { toast.error(`"${file.name}" exceeds the 20 MB image limit`); return false; }
      if (file.size <= MAX_ATTACHMENT_SIZE_BYTES) return true;
      toast.error(`"${file.name}" exceeds ${Math.floor(MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024)} MB limit`); return false;
    });
    if (!valid.length) return;
    if (state.files.length + valid.length > MAX_ATTACHMENTS_PER_MESSAGE) { toast.error(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files`); return; }
    const drafts = valid.map((file) => ({ draftId: createDraftId(), file }));
    if (scope) {
      const result = appendComposerAttachmentSession(scope, drafts);
      if (result.evictedScopes > 0) toast.info("Older attachment drafts were cleared to free memory");
      if (!result.accepted) { toast.error("These files exceed the attachment draft memory limit"); return; }
    }
    protocol.setState((current) => ({ ...current, files: [...current.files, ...drafts.map(pendingDraft)], queued: new Map([...current.queued, ...drafts.map((draft) => [draft.draftId, { generation: state.generation, controller: new AbortController() }] as const)]) }));
    await queuePreparation(drafts, state.generation);
  }, [protocol, queuePreparation]);
  useLayoutEffect(() => {
    if (protocol.get().scope !== draftSessionScope) {
      const previous = protocol.get();
      previous.controller.abort();
      cancelPreparations(previous.queued);
      revokeThumbnailUrls(previous.files);
      protocol.setState((state) => ({ ...state, scope: draftSessionScope, files: [], generation: state.generation + 1, queued: new Map(), controller: new AbortController() }));
    }
    const state = protocol.get();
    const drafts = draftSessionScope ? readComposerAttachmentSession(draftSessionScope) : [];
    const unique = [...new Map(drafts.map((draft) => [draft.draftId, draft])).values()];
    const retained = new Set(state.files.map((file) => file.draftId));
    const missing = unique.filter((draft) => !retained.has(draft.draftId)).slice(0, MAX_ATTACHMENTS_PER_MESSAGE - state.files.length);
    if (!missing.length) return;
    protocol.setState((current) => ({ ...current, files: [...current.files, ...missing.map(pendingDraft)], queued: new Map([...current.queued, ...missing.map((draft) => [draft.draftId, { generation: state.generation, controller: new AbortController() }] as const)]) }));
    void queuePreparation(missing, state.generation).catch(() => undefined);
  }, [draftSessionScope, protocol, queuePreparation]);
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
    assert();
    const files = protocol.get().files;
    if (files.some((file) => file.preparationFailed)) throw new Error("Attachment preparation failed");
    return files;
  }, [client, key, protocol]);
  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => { if (event.target.files) void addPendingFiles(Array.from(event.target.files)).catch(() => undefined); event.target.value = ""; }, [addPendingFiles]);
  const removePendingFile = useCallback((index: number) => {
    const state = protocol.get(), removed = state.files[index];
    const queued = new Map(state.queued);
    if (removed?.draftId) { queued.get(removed.draftId)?.controller.abort(); queued.delete(removed.draftId); }
    if (removed?.draftId && state.scope) removeComposerAttachmentSessionFiles(state.scope, [removed.draftId]);
    if (removed?.thumbnailUrl) URL.revokeObjectURL(removed.thumbnailUrl);
    protocol.setState((current) => ({ ...current, queued, files: current.files.filter((_, item) => item !== index) }));
  }, [protocol]);
  const handleDragEnter = useCallback((event: React.DragEvent) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.stopPropagation(); protocol.setState((state) => ({ ...state, dragDepth: state.dragDepth + 1, dragging: true })); }, [protocol]);
  const handleDragLeave = useCallback((event: React.DragEvent) => { if (!protocol.get().dragging) return; event.preventDefault(); event.stopPropagation(); protocol.setState((state) => ({ ...state, dragDepth: Math.max(0, state.dragDepth - 1), dragging: state.dragDepth > 1 })); }, [protocol]);
  const handleDragOver = useCallback((event: React.DragEvent) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }, []);
  const handleDrop = useCallback((event: React.DragEvent) => { if (!event.dataTransfer.files.length && !event.dataTransfer.types?.includes("Files")) return; event.preventDefault(); event.stopPropagation(); protocol.setState((state) => ({ ...state, dragging: false, dragDepth: 0 })); void addPendingFiles(Array.from(event.dataTransfer.files)).catch(() => undefined); }, [addPendingFiles, protocol]);
  return { pendingFiles, readPendingFiles: () => protocol.get().files, clearPendingFiles, transferPendingFiles, awaitPendingFiles, fileInputRef, addPendingFiles, handleFileSelect, removePendingFile, dragging, handleDragEnter, handleDragLeave, handleDragOver, handleDrop };
}
