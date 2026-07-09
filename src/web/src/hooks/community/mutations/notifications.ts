"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { NotificationSettings } from "@/hooks/community/use-notification-settings"

/**
 * Notification-level mutations. UI presents display strings ("All Messages",
 * "Only @mentions", "Nothing", "Use Server Default"). The API only accepts
 * lowercase — normalise inside the mutation. "Use Server Default" for a
 * channel means "delete the override row".
 */

function normalizeNotifLevel(level: string): "all" | "mentions" | "nothing" {
  if (level === "All Messages") return "all"
  if (level === "Only @mentions") return "mentions"
  if (level === "Nothing") return "nothing"
  if (level === "all" || level === "mentions" || level === "nothing") return level
  return "mentions"
}

// ── Set server notification level ─────────────────────────────────────────

export type SetServerNotifLevelArgs = { serverId: string; level: string }

export function useSetServerNotifLevel() {
  const queryClient = useQueryClient()
  return useMutation<
    void,
    Error,
    SetServerNotifLevelArgs,
    { snapshot: NotificationSettings | undefined }
  >({
    mutationFn: async ({ serverId, level }) => {
      await apiFetch(`/api/community/users/me/notifications/server/${serverId}`, {
        method: "PUT",
        body: JSON.stringify({ level: normalizeNotifLevel(level) }),
      })
    },
    onMutate: async (args) => {
      const key = communityKeys.notificationSettings()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<NotificationSettings>(key)
      queryClient.setQueryData<NotificationSettings | undefined>(key, (prev) =>
        prev ? { ...prev, server: { ...prev.server, [args.serverId]: args.level } } : prev,
      )
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.notificationSettings(), ctx.snapshot)
    },
  })
}

// ── Set channel notification level ────────────────────────────────────────

export type SetChannelNotifArgs = { channelId: string; level: string }

export function useSetChannelNotif() {
  const queryClient = useQueryClient()
  return useMutation<
    void,
    Error,
    SetChannelNotifArgs,
    { snapshot: NotificationSettings | undefined }
  >({
    mutationFn: async ({ channelId, level }) => {
      if (level === "Use Server Default") {
        await apiFetch(`/api/community/users/me/notifications/channel/${channelId}`, {
          method: "DELETE",
        })
        return
      }
      await apiFetch(`/api/community/users/me/notifications/channel/${channelId}`, {
        method: "PUT",
        body: JSON.stringify({ level: normalizeNotifLevel(level) }),
      })
    },
    onMutate: async (args) => {
      const key = communityKeys.notificationSettings()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<NotificationSettings>(key)
      queryClient.setQueryData<NotificationSettings | undefined>(key, (prev) => {
        if (!prev) return prev
        const nextChannel = { ...prev.channel }
        if (args.level === "Use Server Default") {
          delete nextChannel[args.channelId]
        } else {
          nextChannel[args.channelId] = args.level
        }
        return { ...prev, channel: nextChannel }
      })
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.notificationSettings(), ctx.snapshot)
    },
  })
}
