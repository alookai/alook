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
import {
  useNotificationSettingsProjection,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import {
  createNotificationSettingsResourceQueryFn,
  notificationSettingsResourceKey,
  type NotificationSettingsResource,
} from "@/lib/community-db/notification-settings-resource"

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

const DEFAULT_SERVER_NOTIFICATION_LEVEL = notifLevelDisplay("all")

export function resolveServerNotificationDisplayLevel(level?: string): string {
  return level ?? DEFAULT_SERVER_NOTIFICATION_LEVEL
}

export const notificationSettingsQueryFn = async (
  context: QueryFunctionContext = {} as QueryFunctionContext,
): Promise<NotificationSettings> => {
  return createNotificationSettingsResourceQueryFn(context.client, "anon")(context)
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
  const scopeId = getCommunityDbRegistry(queryClient)?.scopeId ?? "anon"
  const queryKey = notificationSettingsResourceKey(scopeId)
  // A policy WS event is newer than any transport already in flight. Cancel
  // that generation first so TanStack cannot dedupe this repair onto the old
  // request and install its stale response after the event.
  await queryClient.cancelQueries({ queryKey, exact: true })
  const settings = await queryClient.query({
    queryKey,
    queryFn: createNotificationSettingsResourceQueryFn(queryClient, scopeId),
    staleTime: 0,
  })
  projectNotificationSettings(getActiveAccountUnreadProjection(queryClient), settings)
  return settings
}

export function useNotificationSettings(): UseQueryResult<NotificationSettings> & {
  server: Record<string, string>
  channel: Record<string, string>
} {
  const registry = useOptionalCommunityDbRegistry()
  const dbSettings = useNotificationSettingsProjection()
  const queryClient = useQueryClient()
  const scopeId = registry?.scopeId ?? "anon"
  const projection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const query = useQuery({
    queryKey: notificationSettingsResourceKey(scopeId),
    queryFn: createNotificationSettingsResourceQueryFn(queryClient, scopeId),
  })
  const projectedSettings = registry ? dbSettings : query.data
  useEffect(() => {
    if (projectedSettings) projectNotificationSettings(projection, projectedSettings)
  }, [projectedSettings, projection])
  return {
    ...query,
    server: registry
      ? dbSettings?.server ?? (EMPTY_NOTIF_SERVER as Record<string, string>)
      : query.data?.server ?? (EMPTY_NOTIF_SERVER as Record<string, string>),
    channel: registry
      ? dbSettings?.channel ?? (EMPTY_NOTIF_CHANNEL as Record<string, string>)
      : query.data?.channel ?? (EMPTY_NOTIF_CHANNEL as Record<string, string>),
  } as UseQueryResult<NotificationSettingsResource> & {
    server: Record<string, string>
    channel: Record<string, string>
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
