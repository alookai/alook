"use client"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"

import { useMutation,useQueryClient,type Query } from "@tanstack/react-query"
import { normalizeNotifLevel,USE_SERVER_DEFAULT } from "@alook/shared"
import { useCommunityMutationOrigin } from "../community-origin"
import { useCommunityViewSource } from "../use-community-view-source"
import { communityKeys } from "@/lib/query-keys"
import { notificationSettingKey } from "@/lib/community-db/schema"
import { beginCommunityCommandRevision,publishCommunityNotificationSetting } from "@/lib/community-db/sync"

type SetServerNotifLevelArgs = { serverId: string; level: string; assertActive?: (() => void) & { signal: AbortSignal } }
type SetChannelNotifArgs = { channelId: string; level: string; assertActive?: (() => void) & { signal: AbortSignal } }

function useNotificationCommand(kind: "server" | "channel") {
  const origin = useCommunityMutationOrigin(), client = useQueryClient()
  const source = useCommunityViewSource("notification-setting:" + kind)
  type Input = SetServerNotifLevelArgs | SetChannelNotifArgs
  type Intent = { input: Input; id: string; original: ReturnType<typeof origin.begin>["token"]; view: ReturnType<typeof source.capture>; resources: Query[] }
  const native = useMutation<void, Error, Intent>({
    mutationKey: ["community", "notification-setting-command", kind],
    scope: { id: "community-notification-setting-commands" },
    gcTime: 0,
    mutationFn: async ({ input, id, original, view, resources }) => {
      const assert = () => { origin.assert(original); view(); input.assertActive?.() }
      assert()
      const registry = origin.registry!
      const signal = input.assertActive?.signal ? AbortSignal.any([input.assertActive.signal, view.signal]) : view.signal
      await registry.ready
      assert()
      await registry.collections.notificationSettings.preload()
      assert()
      for (const query of resources) if (client.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query) await client.cancelQueries({ queryKey: query.queryKey, exact: true })
      assert()
      const token = beginCommunityCommandRevision(client, original)
      const target = { serverId: kind === "server" ? id : null, channelId: kind === "channel" ? id : null }
      const key = notificationSettingKey(target), level = input.level === USE_SERVER_DEFAULT ? null : normalizeNotifLevel(input.level)
      const persist = async () => {
        await origin.request(token, `/api/community/users/me/notifications/${kind}/${id}`, {
          method: level === null ? "DELETE" : "PUT", signal, assertActive: assert,
          ...(level === null ? {} : { body: JSON.stringify({ level }) }),
        })
        assert()
        publishCommunityNotificationSetting(client, target, level, { token, signal })
      }
      const transaction = registry.dbClient.createTransaction({ autoCommit: false, mutationFn: persist })
      transaction.mutate(() => {
        if (level === null) { if (registry.collections.notificationSettings.has(key)) registry.collections.notificationSettings.delete(key) }
        else if (registry.collections.notificationSettings.has(key)) registry.collections.notificationSettings.update(key, (row) => { row.level = level })
        else registry.collections.notificationSettings.insert({ id: key, ...target, level })
      })
      try { if (transaction.mutations.length) await transaction.commit(); else await persist() } catch (error) { assert(); throw error }
      assert()
      for (const query of resources) if (client.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query) void client.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false }).catch(() => undefined)
    },
  })
  const capture = useCallback((input: Input): Intent => {
    input.assertActive?.()
    const view = source.capture(); view()
    const id = "serverId" in input ? input.serverId : input.channelId
    return { input, id, original: origin.begin().token, view, resources: client.getQueryCache().findAll({ predicate: (query) => [communityKeys.notificationSettings(), communityKeys.inbox(), communityKeys.servers()].some((key) => key.length <= query.queryKey.length && key.every((part, i) => Object.is(part, query.queryKey[i]))) || query.queryKey.includes("read-state-snapshot") }) }
  }, [origin, client, source])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.view(); args.input.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}
export function useSetServerNotifLevel() { return useNotificationCommand("server") }
export function useSetChannelNotif() { return useNotificationCommand("channel") }
