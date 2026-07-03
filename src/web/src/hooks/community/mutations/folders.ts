"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { CommunityFolder, FolderServer } from "@/components/community/_types"
import type { FoldersResponse } from "@/hooks/community/use-folders"
import type { ServersResponse } from "@/hooks/community/use-servers"

/**
 * Server-folder mutations mirror the God-context's `createServerFolderWith` /
 * `updateFolderItems` / `deleteServerFolder` / `reorderFolders` — optimistic
 * writes into `communityKeys.folders()`, rollback on failure.
 *
 * The "create folder with two servers" flow is the odd one out because it
 * derives the folder's `servers` from the current `servers` list. That means
 * we need to read the servers cache at call-time to hydrate the temp folder.
 */

// ── Create folder with two servers ─────────────────────────────────────────

export type CreateServerFolderWithArgs = {
  serverIdA: string
  serverIdB: string
}
export type CreateServerFolderWithResult = { id: string }

export function useCreateServerFolderWith() {
  const queryClient = useQueryClient()
  return useMutation<
    CreateServerFolderWithResult,
    Error,
    CreateServerFolderWithArgs,
    { snapshot: FoldersResponse | undefined; tempId: string }
  >({
    mutationFn: async ({ serverIdA, serverIdB }) => {
      return apiFetch<CreateServerFolderWithResult>(
        "/api/community/server-folders",
        {
          method: "POST",
          body: JSON.stringify({ name: "Group", serverIds: [serverIdA, serverIdB] }),
        },
      )
    },
    onMutate: async (args) => {
      const key = communityKeys.folders()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<FoldersResponse>(key)
      const servers = queryClient.getQueryData<ServersResponse>(communityKeys.servers())
      const findServer = (id: string): FolderServer | null => {
        const s = servers?.servers.find((sv) => sv.id === id)
        if (!s) return null
        return { id: s.id, name: s.name, initial: s.initial, icon: s.icon ?? null }
      }
      const tempId = `temp_${Date.now()}`
      const tempFolder: CommunityFolder = {
        id: tempId,
        name: "Group",
        position: snapshot?.folders.length ?? 0,
        servers: [findServer(args.serverIdA), findServer(args.serverIdB)].filter(
          (s): s is FolderServer => s !== null,
        ),
      }
      queryClient.setQueryData<FoldersResponse | undefined>(key, (prev) =>
        prev
          ? { ...prev, folders: [...prev.folders, tempFolder] }
          : { folders: [tempFolder] },
      )
      return { snapshot, tempId }
    },
    onError: (_err, _args, ctx) => {
      if (!ctx) return
      // If we have a full pre-mutation snapshot, restore it. Otherwise remove
      // just the temp row so we don't obliterate concurrently-updated folders.
      if (ctx.snapshot) {
        queryClient.setQueryData(communityKeys.folders(), ctx.snapshot)
        return
      }
      queryClient.setQueryData<FoldersResponse | undefined>(
        communityKeys.folders(),
        (prev) => (prev ? { ...prev, folders: prev.folders.filter((f) => f.id !== ctx.tempId) } : prev),
      )
    },
    onSuccess: (data, _args, ctx) => {
      if (!ctx) return
      queryClient.setQueryData<FoldersResponse | undefined>(
        communityKeys.folders(),
        (prev) =>
          prev
            ? { ...prev, folders: prev.folders.map((f) => (f.id === ctx.tempId ? { ...f, id: data.id } : f)) }
            : prev,
      )
    },
  })
}

// ── Update folder items ────────────────────────────────────────────────────

export type UpdateFolderItemsArgs = {
  folderId: string
  serverIds: string[]
}

export function useUpdateFolderItems() {
  const queryClient = useQueryClient()
  return useMutation<
    void,
    Error,
    UpdateFolderItemsArgs,
    { snapshot: FoldersResponse | undefined }
  >({
    mutationFn: async ({ folderId, serverIds }) => {
      if (serverIds.length === 0) {
        await apiFetch(`/api/community/server-folders/${folderId}`, { method: "DELETE" })
        return
      }
      await apiFetch(`/api/community/server-folders/${folderId}`, {
        method: "PATCH",
        body: JSON.stringify({ serverIds }),
      })
    },
    onMutate: async (args) => {
      const key = communityKeys.folders()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<FoldersResponse>(key)
      const railServers = queryClient.getQueryData<ServersResponse>(communityKeys.servers())
      queryClient.setQueryData<FoldersResponse | undefined>(key, (prev) => {
        if (!prev) return prev
        if (args.serverIds.length === 0) {
          return { ...prev, folders: prev.folders.filter((f) => f.id !== args.folderId) }
        }
        return {
          ...prev,
          folders: prev.folders.map((f) => {
            if (f.id !== args.folderId) return f
            const newServers = args.serverIds.map((id) => {
              const existing = f.servers.find((s) => s.id === id)
              if (existing) return existing
              const fromRail = railServers?.servers.find((s) => s.id === id)
              return fromRail
                ? { id: fromRail.id, name: fromRail.name, initial: fromRail.initial, icon: fromRail.icon ?? null }
                : { id, name: "", initial: "?", icon: null }
            })
            return { ...f, servers: newServers }
          }),
        }
      })
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.folders(), ctx.snapshot)
    },
  })
}

// ── Delete folder ─────────────────────────────────────────────────────────

export type DeleteServerFolderArgs = { folderId: string }

export function useDeleteServerFolder() {
  const queryClient = useQueryClient()
  return useMutation<
    void,
    Error,
    DeleteServerFolderArgs,
    { snapshot: FoldersResponse | undefined }
  >({
    mutationFn: async ({ folderId }) => {
      await apiFetch(`/api/community/server-folders/${folderId}`, { method: "DELETE" })
    },
    onMutate: async (args) => {
      const key = communityKeys.folders()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<FoldersResponse>(key)
      queryClient.setQueryData<FoldersResponse | undefined>(key, (prev) =>
        prev ? { ...prev, folders: prev.folders.filter((f) => f.id !== args.folderId) } : prev,
      )
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.folders(), ctx.snapshot)
    },
  })
}

// ── Reorder folders ────────────────────────────────────────────────────────

export type ReorderFoldersArgs = { folderIds: string[] }

export function useReorderFolders() {
  const queryClient = useQueryClient()
  return useMutation<
    void,
    Error,
    ReorderFoldersArgs,
    { snapshot: FoldersResponse | undefined }
  >({
    mutationFn: async ({ folderIds }) => {
      await apiFetch("/api/community/server-folders/reorder", {
        method: "PATCH",
        body: JSON.stringify({ folderIds }),
      })
    },
    onMutate: async (args) => {
      const key = communityKeys.folders()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<FoldersResponse>(key)
      queryClient.setQueryData<FoldersResponse | undefined>(key, (prev) => {
        if (!prev) return prev
        const map = new Map(prev.folders.map((f) => [f.id, f]))
        return {
          ...prev,
          folders: args.folderIds
            .map((id, i) => {
              const f = map.get(id)
              return f ? { ...f, position: i } : null
            })
            .filter((f): f is CommunityFolder => f !== null),
        }
      })
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.folders(), ctx.snapshot)
    },
  })
}
