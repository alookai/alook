"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import type { ServersResponse, ServerDetail } from "@/hooks/community/use-servers"

/**
 * Server-scoped mutations. `create`/`join` invalidate the rail; `leave`/`delete`
 * optimistically prune the rail. `update` patches the server detail cache
 * directly so the settings surface reflects the change immediately.
 */

// ── Create server ──────────────────────────────────────────────────────────

export type CreateServerArgs = { name: string }
export type CreateServerResult = { server: { id: string } }

export function useCreateServer() {
  const queryClient = useQueryClient()
  return useMutation<CreateServerResult, Error, CreateServerArgs>({
    mutationFn: async ({ name }) => {
      return apiFetch<CreateServerResult>("/api/community/servers", {
        method: "POST",
        body: JSON.stringify({ name }),
      })
    },
    onSuccess: () => {
      // The server row includes owner/role metadata we don't get from the
      // response — refetch to hydrate the rail correctly.
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
    },
  })
}

// ── Join server (via invite token) ─────────────────────────────────────────

export type JoinServerArgs = { inviteCode: string }
export type JoinServerResult = { serverId: string }

export function useJoinServer() {
  const queryClient = useQueryClient()
  return useMutation<JoinServerResult, Error, JoinServerArgs>({
    mutationFn: async ({ inviteCode }) => {
      let token = inviteCode.trim()
      try {
        const url = new URL(token)
        const segments = url.pathname.split("/").filter(Boolean)
        const inviteIdx = segments.indexOf("invite")
        if (inviteIdx !== -1 && segments[inviteIdx + 1]) {
          token = segments[inviteIdx + 1]
        }
      } catch {
        // Not a URL — raw token.
      }
      return apiFetch<JoinServerResult>(
        `/api/community/invites/${token}/join`,
        { method: "POST" },
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
    },
  })
}

// ── Leave / delete server ──────────────────────────────────────────────────

export type LeaveServerArgs = { serverId: string }

export function useLeaveServer() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, LeaveServerArgs, { snapshot: ServersResponse | undefined }>({
    mutationFn: async ({ serverId }) => {
      await apiFetch(`/api/community/servers/${serverId}/leave`, { method: "POST" })
    },
    onMutate: async (args) => {
      const key = communityKeys.servers()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<ServersResponse>(key)
      queryClient.setQueryData<ServersResponse | undefined>(key, (prev) =>
        prev ? { ...prev, servers: prev.servers.filter((s) => s.id !== args.serverId) } : prev,
      )
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.servers(), ctx.snapshot)
    },
  })
}

export function useDeleteServer() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, LeaveServerArgs, { snapshot: ServersResponse | undefined }>({
    mutationFn: async ({ serverId }) => {
      await apiFetch(`/api/community/servers/${serverId}`, { method: "DELETE" })
    },
    onMutate: async (args) => {
      const key = communityKeys.servers()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<ServersResponse>(key)
      queryClient.setQueryData<ServersResponse | undefined>(key, (prev) =>
        prev ? { ...prev, servers: prev.servers.filter((s) => s.id !== args.serverId) } : prev,
      )
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.servers(), ctx.snapshot)
    },
  })
}

// ── Update server (name + description) ─────────────────────────────────────

export type UpdateServerArgs = {
  serverId: string
  name: string
  description: string
}

export function useUpdateServer() {
  const queryClient = useQueryClient()
  return useMutation<
    void,
    Error,
    UpdateServerArgs,
    { serverSnap: ServerDetail | undefined; listSnap: ServersResponse | undefined }
  >({
    mutationFn: async ({ serverId, name, description }) => {
      await apiFetch(`/api/community/servers/${serverId}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description }),
      })
    },
    onMutate: async (args) => {
      const detailKey = communityKeys.server(args.serverId)
      const listKey = communityKeys.servers()
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey }),
        queryClient.cancelQueries({ queryKey: listKey }),
      ])
      const serverSnap = queryClient.getQueryData<ServerDetail>(detailKey)
      const listSnap = queryClient.getQueryData<ServersResponse>(listKey)
      queryClient.setQueryData<ServerDetail | undefined>(detailKey, (prev) =>
        prev ? { ...prev, name: args.name, description: args.description } : prev,
      )
      queryClient.setQueryData<ServersResponse | undefined>(listKey, (prev) =>
        prev
          ? {
              ...prev,
              servers: prev.servers.map((s) =>
                s.id === args.serverId ? { ...s, name: args.name, initial: avatarInitial(args.name) } : s,
              ),
            }
          : prev,
      )
      return { serverSnap, listSnap }
    },
    onError: (_err, args, ctx) => {
      if (ctx?.serverSnap) queryClient.setQueryData(communityKeys.server(args.serverId), ctx.serverSnap)
      if (ctx?.listSnap) queryClient.setQueryData(communityKeys.servers(), ctx.listSnap)
    },
  })
}

// ── Upload server icon ─────────────────────────────────────────────────────

export type UploadServerIconArgs = { serverId: string; file: File }
export type UploadServerIconResult = { url: string }

export function useUploadServerIcon() {
  const queryClient = useQueryClient()
  return useMutation<UploadServerIconResult, Error, UploadServerIconArgs>({
    mutationFn: async ({ serverId, file }) => {
      const formData = new FormData()
      formData.append("file", file)
      const res = await fetch(`/api/community/servers/${serverId}/icon`, {
        method: "POST",
        body: formData,
        credentials: "include",
      })
      if (!res.ok) throw new Error("Upload failed")
      return (await res.json()) as UploadServerIconResult
    },
    onSuccess: (data, args) => {
      const bustUrl = `${data.url}?t=${Date.now()}`
      queryClient.setQueryData<ServerDetail | undefined>(
        communityKeys.server(args.serverId),
        (prev) => (prev ? { ...prev, icon: bustUrl } : prev),
      )
      queryClient.setQueryData<ServersResponse | undefined>(
        communityKeys.servers(),
        (prev) =>
          prev
            ? {
                ...prev,
                servers: prev.servers.map((s) =>
                  s.id === args.serverId ? { ...s, icon: bustUrl } : s,
                ),
              }
            : prev,
      )
    },
  })
}
