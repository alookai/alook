"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

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

// API-level ("all"|"mentions"|"nothing") → display strings.
function displayNotifLevel(level: string): string {
  if (level === "all") return "All Messages"
  if (level === "mentions") return "Only @mentions"
  if (level === "nothing") return "Nothing"
  return level
}

export const notificationSettingsQueryFn = async (): Promise<NotificationSettings> => {
  const rows = await apiFetch<NotificationSettingRow[]>(
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

export function useNotificationSettings(): UseQueryResult<NotificationSettings> & {
  server: Record<string, string>
  channel: Record<string, string>
} {
  const query = useQuery({
    queryKey: communityKeys.notificationSettings(),
    queryFn: notificationSettingsQueryFn,
  })
  return {
    ...query,
    server: query.data?.server ?? (EMPTY_NOTIF_SERVER as Record<string, string>),
    channel: query.data?.channel ?? (EMPTY_NOTIF_CHANNEL as Record<string, string>),
  }
}
