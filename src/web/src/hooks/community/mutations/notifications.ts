"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { normalizeNotifLevel, USE_SERVER_DEFAULT } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import type { AccountUnreadPolicyToken } from "@/hooks/community/account-unread-projection"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import {
  notificationSettingKey,
  type NotificationSettingRow,
} from "@/lib/community-db/schema"
import { notificationSettingsResourceKey } from "@/lib/community-db/notification-settings-resource"

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
      previous: NotificationSettingRow | undefined
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
      const registry = getCommunityDbRegistry(queryClient)
      const key = notificationSettingsResourceKey(registry?.scopeId ?? "anon")
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      const id = notificationSettingKey({ serverId: args.serverId, channelId: null })
      const previous = registry?.collections.notificationSettings.get(id)
      registry?.collections.notificationSettings.utils.writeUpsert({
        id,
        serverId: args.serverId,
        channelId: null,
        level: normalizeNotifLevel(args.level),
      })
      const token = projection.beginNotificationPolicyOverlay({
        kind: "server",
        id: args.serverId,
        level: args.level,
      })
      return { previous, token }
    },
    onError: (_err, args, ctx) => {
      if (ctx) projection.rollbackNotificationPolicyOverlay(ctx.token)
      const registry = getCommunityDbRegistry(queryClient)
      if (!registry || !ctx) return
      const id = notificationSettingKey({ serverId: args.serverId, channelId: null })
      const current = registry.collections.notificationSettings.get(id)
      if (current?.level !== normalizeNotifLevel(args.level)) return
      if (ctx.previous) registry.collections.notificationSettings.utils.writeUpsert(ctx.previous)
      else if (registry.collections.notificationSettings.has(id)) {
        registry.collections.notificationSettings.utils.writeDelete(id)
      }
    },
    onSuccess: (_data, _args, ctx) => {
      if (ctx) projection.commitNotificationPolicyOverlay(ctx.token)
      const scopeId = getCommunityDbRegistry(queryClient)?.scopeId ?? "anon"
      queryClient.invalidateQueries({
        queryKey: notificationSettingsResourceKey(scopeId),
        exact: true,
      })
      queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
      queryClient.invalidateQueries({ queryKey: serversCollectionQueryKey(), exact: true })
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
      previous: NotificationSettingRow | undefined
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
      const registry = getCommunityDbRegistry(queryClient)
      const key = notificationSettingsResourceKey(registry?.scopeId ?? "anon")
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      const id = notificationSettingKey({ serverId: null, channelId: args.channelId })
      const previous = registry?.collections.notificationSettings.get(id)
      if (registry) {
        if (args.level === USE_SERVER_DEFAULT) {
          if (registry.collections.notificationSettings.has(id)) {
            registry.collections.notificationSettings.utils.writeDelete(id)
          }
        } else {
          registry.collections.notificationSettings.utils.writeUpsert({
            id,
            serverId: null,
            channelId: args.channelId,
            level: normalizeNotifLevel(args.level),
          })
        }
      }
      const token = projection.beginNotificationPolicyOverlay({
        kind: "channel",
        id: args.channelId,
        level: args.level === USE_SERVER_DEFAULT ? null : args.level,
      })
      return {
        previous,
        token,
      }
    },
    onError: (_err, args, ctx) => {
      if (ctx) projection.rollbackNotificationPolicyOverlay(ctx.token)
      const registry = getCommunityDbRegistry(queryClient)
      if (!registry || !ctx) return
      const id = notificationSettingKey({ serverId: null, channelId: args.channelId })
      const current = registry.collections.notificationSettings.get(id)
      if (args.level === USE_SERVER_DEFAULT ? current !== undefined : (
        current?.level !== normalizeNotifLevel(args.level)
      )) return
      if (ctx.previous) registry.collections.notificationSettings.utils.writeUpsert(ctx.previous)
      else if (registry.collections.notificationSettings.has(id)) {
        registry.collections.notificationSettings.utils.writeDelete(id)
      }
    },
    onSuccess: (_data, _args, ctx) => {
      if (ctx) projection.commitNotificationPolicyOverlay(ctx.token)
      const scopeId = getCommunityDbRegistry(queryClient)?.scopeId ?? "anon"
      queryClient.invalidateQueries({
        queryKey: notificationSettingsResourceKey(scopeId),
        exact: true,
      })
      queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
      queryClient.invalidateQueries({ queryKey: serversCollectionQueryKey(), exact: true })
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) => queryKey.includes("read-state-snapshot"),
      })
    },
  })
}
