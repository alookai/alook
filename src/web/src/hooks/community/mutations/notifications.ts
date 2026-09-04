"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { normalizeNotifLevel, USE_SERVER_DEFAULT } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { NotificationSettings } from "@/hooks/community/use-notification-settings"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import type { AccountUnreadPolicyToken } from "@/hooks/community/account-unread-projection"

/**
 * Notification-level mutations. UI presents display strings ("All Messages",
 * "Only @mentions", "Nothing", USE_SERVER_DEFAULT). The API only accepts the
 * lowercase values — `normalizeNotifLevel` (shared single-source) maps
 * display→value. USE_SERVER_DEFAULT for a channel means "delete the override
 * row" and is handled at the call sites BEFORE normalization.
 */

// ── Set server notification level ─────────────────────────────────────────

export type SetServerNotifLevelArgs = { serverId: string; level: string }

export function useSetServerNotifLevel() {
  const queryClient = useQueryClient()
  const projection = getActiveAccountUnreadProjection(queryClient)
  return useMutation<
    void,
    Error,
    SetServerNotifLevelArgs,
    {
      previousLevel: string | undefined
      token: AccountUnreadPolicyToken
    }
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
      const next = snapshot
        ? { ...snapshot, server: { ...snapshot.server, [args.serverId]: args.level } }
        : undefined
      queryClient.setQueryData<NotificationSettings | undefined>(key, next)
      const token = projection.beginNotificationPolicyOverlay({
        kind: "server",
        id: args.serverId,
        level: args.level,
      })
      return { previousLevel: snapshot?.server[args.serverId], token }
    },
    onError: (_err, args, ctx) => {
      if (ctx) projection.rollbackNotificationPolicyOverlay(ctx.token)
      queryClient.setQueryData<NotificationSettings | undefined>(
        communityKeys.notificationSettings(),
        (current) => {
          if (!current || !ctx || current.server[args.serverId] !== args.level) return current
          const server = { ...current.server }
          if (ctx.previousLevel === undefined) delete server[args.serverId]
          else server[args.serverId] = ctx.previousLevel
          return { ...current, server }
        },
      )
    },
    onSuccess: (_data, _args, ctx) => {
      if (ctx) projection.commitNotificationPolicyOverlay(ctx.token)
      queryClient.invalidateQueries({ queryKey: communityKeys.notificationSettings() })
      queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
      queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) => queryKey.includes("read-state-snapshot"),
      })
    },
  })
}

// ── Set channel notification level ────────────────────────────────────────

export type SetChannelNotifArgs = { channelId: string; level: string }

export function useSetChannelNotif() {
  const queryClient = useQueryClient()
  const projection = getActiveAccountUnreadProjection(queryClient)
  return useMutation<
    void,
    Error,
    SetChannelNotifArgs,
    {
      previousLevel: string | undefined
      optimisticLevel: string | undefined
      token: AccountUnreadPolicyToken
    }
  >({
    mutationFn: async ({ channelId, level }) => {
      if (level === USE_SERVER_DEFAULT) {
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
      let next: NotificationSettings | undefined
      if (snapshot) {
        const nextChannel = { ...snapshot.channel }
        if (args.level === USE_SERVER_DEFAULT) delete nextChannel[args.channelId]
        else nextChannel[args.channelId] = args.level
        next = { ...snapshot, channel: nextChannel }
      }
      queryClient.setQueryData<NotificationSettings | undefined>(key, next)
      const token = projection.beginNotificationPolicyOverlay({
        kind: "channel",
        id: args.channelId,
        level: args.level === USE_SERVER_DEFAULT ? null : args.level,
      })
      return {
        previousLevel: snapshot?.channel[args.channelId],
        optimisticLevel: args.level === USE_SERVER_DEFAULT ? undefined : args.level,
        token,
      }
    },
    onError: (_err, args, ctx) => {
      if (ctx) projection.rollbackNotificationPolicyOverlay(ctx.token)
      queryClient.setQueryData<NotificationSettings | undefined>(
        communityKeys.notificationSettings(),
        (current) => {
          if (!current || !ctx || current.channel[args.channelId] !== ctx.optimisticLevel) {
            return current
          }
          const channel = { ...current.channel }
          if (ctx.previousLevel === undefined) delete channel[args.channelId]
          else channel[args.channelId] = ctx.previousLevel
          return { ...current, channel }
        },
      )
    },
    onSuccess: (_data, _args, ctx) => {
      if (ctx) projection.commitNotificationPolicyOverlay(ctx.token)
      queryClient.invalidateQueries({ queryKey: communityKeys.notificationSettings() })
      queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
      queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) => queryKey.includes("read-state-snapshot"),
      })
    },
  })
}
