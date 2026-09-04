"use client"

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { notifLevelDisplay } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { useEffect, useMemo } from "react"
import {
  getActiveAccountUnreadProjection,
  type AccountUnreadProjection,
} from "./account-unread-projection"

/**
 * Fetches the user's notification-setting rows and materialises them into
 * `{ server: { [serverId]: displayLevel }, channel: { [channelId]: displayLevel } }`
 * — the shape the settings UI consumes. Display strings ("All Messages",
 * "Only @mentions", "Nothing") mirror the mapping in the old context.
 */
type NotificationSettingRow = {
  serverId?: string | null
  channelId?: string | null
  level: string
}

export type NotificationSettings = {
  raw: NotificationSettingRow[]
  server: Record<string, string>
  channel: Record<string, string>
}

// Frozen empty fallbacks — reused across renders while the query is loading
// so consumers reading `server` / `channel` in a `useEffect` dep array don't
// re-fire per render (a fresh `{}` would churn the reference).
const EMPTY_NOTIF_SERVER: Readonly<Record<string, string>> = Object.freeze({})
const EMPTY_NOTIF_CHANNEL: Readonly<Record<string, string>> = Object.freeze({})

// API-level ("all"|"mentions"|"nothing") → display string, from the shared
// single-source bijection (`notifLevelDisplay`). Was a hand-rolled map that
// drifted on casing ("All Messages" vs the shared const's "All messages").
const displayNotifLevel = notifLevelDisplay

const DEFAULT_SERVER_NOTIFICATION_LEVEL = notifLevelDisplay("all")

export function resolveServerNotificationDisplayLevel(level?: string): string {
  return level ?? DEFAULT_SERVER_NOTIFICATION_LEVEL
}

export const notificationSettingsQueryFn = async (
  context: QueryFunctionContext = {} as QueryFunctionContext,
): Promise<NotificationSettings> => {
  const rows = context.signal
    ? await apiFetch<NotificationSettingRow[]>(
        "/api/community/users/me/notifications",
        { signal: context.signal },
      )
    : await apiFetch<NotificationSettingRow[]>(
        "/api/community/users/me/notifications",
      )
  const server: Record<string, string> = {}
  const channel: Record<string, string> = {}
  for (const s of rows) {
    const level = displayNotifLevel(s.level)
    if (s.channelId) channel[s.channelId] = level
    else if (s.serverId) server[s.serverId] = level
  }
  return { raw: rows, server, channel }
}

function projectNotificationSettings(
  projection: AccountUnreadProjection,
  settings: Pick<NotificationSettings, "server" | "channel"> | undefined,
) {
  projection.setNotificationPolicy({
    server: settings?.server ?? {},
    channel: settings?.channel ?? {},
  })
}

export async function reconcileNotificationSettings(queryClient: QueryClient) {
  const queryKey = communityKeys.notificationSettings()
  // A policy WS event is newer than any transport already in flight. Cancel
  // that generation first so TanStack cannot dedupe this repair onto the old
  // request and install its stale response after the event.
  await queryClient.cancelQueries({ queryKey, exact: true })
  const settings = await queryClient.fetchQuery({
    queryKey,
    queryFn: notificationSettingsQueryFn,
    staleTime: 0,
  })
  projectNotificationSettings(getActiveAccountUnreadProjection(queryClient), settings)
  return settings
}

export function useNotificationSettings(): UseQueryResult<NotificationSettings> & {
  server: Record<string, string>
  channel: Record<string, string>
} {
  const queryClient = useQueryClient()
  const projection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const query = useQuery({
    queryKey: communityKeys.notificationSettings(),
    queryFn: notificationSettingsQueryFn,
  })
  useEffect(() => {
    if (query.data) projectNotificationSettings(projection, query.data)
  }, [projection, query.data])
  return {
    ...query,
    server: query.data?.server ?? (EMPTY_NOTIF_SERVER as Record<string, string>),
    channel: query.data?.channel ?? (EMPTY_NOTIF_CHANNEL as Record<string, string>),
  }
}

export type BotNotificationScope = { kind: "server" | "channel"; id: string }

type BotNotificationSetting = { level: string | null }

export function useBotNotificationSetting(
  botId: string | null,
  scope: BotNotificationScope,
) {
  return useQuery({
    queryKey: communityKeys.botNotificationSetting(botId ?? "", scope.kind, scope.id),
    queryFn: () => apiFetch<BotNotificationSetting>(
      `/api/community/bots/${botId}/notifications/${scope.kind}/${scope.id}`,
    ),
    enabled: Boolean(botId),
  })
}

export function useSetBotNotificationSetting() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ botId, scope, level }: {
      botId: string
      scope: BotNotificationScope
      level: string | null
    }) => {
      const url = `/api/community/bots/${botId}/notifications/${scope.kind}/${scope.id}`
      if (level === null) {
        await apiFetch(url, { method: "DELETE" })
      } else {
        await apiFetch(url, {
          method: "PUT",
          body: JSON.stringify({ level }),
        })
      }
    },
    onSuccess: (_data, args) => {
      queryClient.invalidateQueries({
        queryKey: communityKeys.botNotificationSetting(args.botId, args.scope.kind, args.scope.id),
      })
      queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) => queryKey.includes("read-state-snapshot"),
      })
    },
  })
}
