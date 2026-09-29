import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query"
import { notifLevelDisplay } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import {
  notificationSettingKey,
  type NotificationSettingRow,
} from "./schema"

export type RawNotificationSetting = {
  serverId?: string | null
  channelId?: string | null
  level: string
}

export type NotificationSettingsResource = {
  raw: RawNotificationSetting[]
  rows: NotificationSettingRow[]
  server: Record<string, string>
  channel: Record<string, string>
}

export function notificationSettingsResourceKey(accountId: string) {
  return ["community", "db", accountId, "notification-settings-resource"] as const
}

function normalizeNotificationSettingsResource(
  raw: RawNotificationSetting[],
): NotificationSettingsResource {
  const server: Record<string, string> = {}
  const channel: Record<string, string> = {}
  const rows: NotificationSettingRow[] = []
  for (const setting of raw) {
    if (Boolean(setting.serverId) === Boolean(setting.channelId)) continue
    const target = {
      serverId: setting.serverId ?? null,
      channelId: setting.channelId ?? null,
    }
    rows.push({ id: notificationSettingKey(target), ...target, level: setting.level })
    const display = notifLevelDisplay(setting.level)
    if (target.channelId) channel[target.channelId] = display
    else if (target.serverId) server[target.serverId] = display
  }
  return { raw, rows, server, channel }
}

export function createNotificationSettingsResourceQueryFn(
  _queryClient: QueryClient,
  _accountId: string,
) {
  return async ({ signal }: QueryFunctionContext): Promise<NotificationSettingsResource> => (
    normalizeNotificationSettingsResource(
      await apiFetch<RawNotificationSetting[]>(
        "/api/community/users/me/notifications",
        { signal },
      ),
    )
  )
}

export function selectNotificationSettingRows(resource: NotificationSettingsResource) {
  return resource.rows
}
