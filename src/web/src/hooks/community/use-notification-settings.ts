"use client"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"

import {
  useMutation,
  useQuery,
  useQueryClient,
  QueryObserver,
  type Query,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { notifLevelDisplay } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { useCallback, useEffect, useMemo } from "react"
import { useCommunityMutationOrigin } from "./community-origin"
import { useCommunityViewSource } from "./use-community-view-source"

import { notificationSettingKey } from "@/lib/community-db/schema"
import {
  getActiveAccountUnreadProjection,
  type AccountUnreadProjection,
} from "./account-unread-projection"
import {
  useNotificationSettingsProjection,
  } from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  assertCommunityLiveSnapshotTokenCurrent,
  publishCommunityLiveSnapshot,
} from "@/lib/community-db/sync"

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
): Promise<{ ids: string[] }> => {
  const publicationToken = captureCommunityLiveSnapshotToken(context.client)
  const registry = publicationToken.registry
  if (!registry) throw new DOMException("Missing notification owner", "AbortError")
  await registry.ready
  assertCommunityLiveSnapshotTokenCurrent(context.client, publicationToken, context.signal)
  await registry.collections.notificationSettings.preload()
  assertCommunityLiveSnapshotTokenCurrent(context.client, publicationToken, context.signal)
  const rows = await apiFetch<NotificationSettingRow[]>(
    "/api/community/users/me/notifications",
    communityRequestOptions(context.client, publicationToken, context.signal),
  )
  const server: Record<string, string> = {}
  const channel: Record<string, string> = {}
  for (const s of rows) {
    const level = displayNotifLevel(s.level)
    if (s.channelId) channel[s.channelId] = level
    else if (s.serverId) server[s.serverId] = level
  }
  const data = { raw: rows, server, channel }
  if (context.client && publicationToken) {
    publishCommunityLiveSnapshot(context.client, {
      snapshot: { kind: "notification-settings", data },
      proof: { kind: "structural", token: publicationToken, signal: context.signal },
    })
  }
  return { ids: rows.filter((row) => Boolean(row.serverId) !== Boolean(row.channelId)).map((row) => notificationSettingKey(row)) }
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
  const token = captureCommunityLiveSnapshotToken(queryClient)
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
  const queryKey = communityKeys.notificationSettings()
  // A policy WS event is newer than any transport already in flight. Cancel
  // that generation first so TanStack cannot dedupe this repair onto the old
  // request and install its stale response after the event.
  await queryClient.cancelQueries({ queryKey, exact: true })
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
  const options = { queryKey, queryFn: notificationSettingsQueryFn, staleTime: 0 }
  const lease = new QueryObserver(queryClient, { ...options, enabled: false }).subscribe(() => undefined)
  try { await queryClient.fetchQuery(options) } finally { lease() }
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
  const settings: NotificationSettings = { raw: [...token.registry!.collections.notificationSettings.values()], server: {}, channel: {} }
  for (const row of settings.raw) { if (row.channelId) settings.channel[row.channelId] = displayNotifLevel(row.level); else if (row.serverId) settings.server[row.serverId] = displayNotifLevel(row.level) }
  projectNotificationSettings(getActiveAccountUnreadProjection(queryClient), settings)
  return settings
}

export function useNotificationSettings(): UseQueryResult<NotificationSettings> & {
  server: Record<string, string>
  channel: Record<string, string>
} {
  const dbSettings = useNotificationSettingsProjection()
  const queryClient = useQueryClient()
  const projection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const query = useQuery({
    queryKey: communityKeys.notificationSettings(),
    queryFn: notificationSettingsQueryFn,
  })
  const projectedSettings = dbSettings
  useEffect(() => {
    if (projectedSettings) projectNotificationSettings(projection, projectedSettings)
  }, [projectedSettings, projection])
  return {
    ...query,
    data: dbSettings,
    server: dbSettings?.server ?? (EMPTY_NOTIF_SERVER as Record<string, string>),
    channel: dbSettings?.channel ?? (EMPTY_NOTIF_CHANNEL as Record<string, string>),
  } as UseQueryResult<NotificationSettings> & { server: Record<string, string>; channel: Record<string, string> }
}

export type BotNotificationScope = { kind: "server" | "channel"; id: string }

type BotNotificationSetting = { level: string | null }

export function useBotNotificationSetting(
  botId: string | null,
  scope: BotNotificationScope,
) {
  return useQuery({
    queryKey: communityKeys.botNotificationSetting(botId ?? "", scope.kind, scope.id),
    queryFn: ({ client, signal }) => apiFetch<BotNotificationSetting>(
      `/api/community/bots/${botId}/notifications/${scope.kind}/${scope.id}`,
      communityRequestOptions(client, captureCommunityLiveSnapshotToken(client), signal),
    ),
    enabled: Boolean(botId),
    subscribed: Boolean(botId),
  })
}

export function useSetBotNotificationSetting() {
  const queryClient = useQueryClient()
  const origin = useCommunityMutationOrigin(), source = useCommunityViewSource("bot-notification-setting")
  type Input = { botId: string; scope: BotNotificationScope; level: string | null; assertActive?: (() => void) & { signal: AbortSignal } }
  type Intent = Input & { original: ReturnType<typeof origin.begin>["token"]; view: ReturnType<typeof source.capture>; resources: Query[] }
  const native = useMutation({ meta: { observabilityAction: "bot.notification.update" },
    mutationKey: ["community", "bot-notification-setting-command"], scope: { id: "community-bot-notification-setting-commands" }, gcTime: 0,
    mutationFn: async ({ botId, scope, level, original, view, resources, assertActive }: Intent) => {
      const assert = () => { origin.assert(original); view(); assertActive?.() }
      assert()
      const url = `/api/community/bots/${botId}/notifications/${scope.kind}/${scope.id}`
      await origin.request(original, url, { method: level === null ? "DELETE" : "PUT", signal: assertActive?.signal ? AbortSignal.any([assertActive.signal, view.signal]) : view.signal, assertActive: assert, ...(level === null ? {} : { body: JSON.stringify({ level }) }) })
      assert()
      for (const query of resources) if (queryClient.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query) void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false }).catch(() => undefined)
    },
  })
  const capture = useCallback((input: Input): Intent => { input.assertActive?.(); const view = source.capture(); view(); return { ...input, view, original: origin.begin().token, resources: queryClient.getQueryCache().findAll({ predicate: (query) => [communityKeys.botNotificationSetting(input.botId, input.scope.kind, input.scope.id), communityKeys.inbox()].some((key) => key.length <= query.queryKey.length && key.every((part, i) => Object.is(part, query.queryKey[i]))) || query.queryKey.includes("read-state-snapshot") }) } }, [origin, source, queryClient])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.view(); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}
