"use client"

import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { COMMUNITY_BOT_ACTOR_HEADER, parseRef, type CommunityCliChannelGroup } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityMutationOrigin } from "./community-origin"
import { useCommunityViewSource } from "./use-community-view-source"
import { beginBotDirectoryRead, captureBotDirectoryCommand, assertBotDirectoryCommandCurrent } from "@/lib/community/bot-directory-read"
import { retireBotDirectoryScopes } from "@/lib/community/bot-directory-lifecycle"
import type { BotReadProof } from "@/lib/community/bot-directory-window"
import { ApiError } from "@/lib/errors"
import type { Query } from "@tanstack/react-query"

type BotMembershipChannel = { id: string; channelId?: string; name: string; type: "text" | "forum"; visibility: "public" | "private"; canLeave?: boolean }
type BotMembershipServer = { id: string; name: string; handle: string; icon: string | null; canLeave?: boolean; channels: BotMembershipChannel[] }
export type BotMembershipTarget = { kind: "channel" | "server"; id: string; ref: string; name: string; serverName?: string; publicChannelName?: string; resourceId?: string }
type Memberships = { groups: Array<Omit<CommunityCliChannelGroup, "channels"> & { channels: Array<CommunityCliChannelGroup["channels"][number] & { id?: string }> }>; servers: Omit<BotMembershipServer, "channels">[] }

export function useBotMemberships(botId: string, open: boolean) {
  const client = useQueryClient()
  const origin = useCommunityMutationOrigin()
  const source = useCommunityViewSource(`bot-memberships:${botId}`, open)
  const queryKey = communityKeys.botMemberships(botId)
  const mutationKey = [...queryKey, "leave"]
  const pending = useIsMutating({ mutationKey }) > 0
  type Data = BotReadProof & { servers: BotMembershipServer[] }
  type LeaveIntent = { target: BotMembershipTarget; confirmation: Query; view: ReturnType<typeof source.capture> }
  const query = useQuery<Data>({
    queryKey,
    enabled: open,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const view = source.capture()
      view()
      const read = await beginBotDirectoryRead(client, queryKey, signal)
      const assert = () => { read.assert(); view() }
      assert()
      let data: Memberships
      try {
        data = await origin.fetch<Memberships>("/api/community/servers/channels", { signal: AbortSignal.any([signal, view.signal]), assertActive: assert, headers: { [COMMUNITY_BOT_ACTOR_HEADER]: botId } })
        assert()
      } catch (error) {
        assert()
        if (error instanceof ApiError && [403, 404].includes(error.status)) await retireBotDirectoryScopes(read.registry, [{ kind: "bot", id: botId }], read.query).catch(cause => console.error("Bot memberships retirement failed", cause))
        throw error
      }
      const channelsByServer = new Map<string, BotMembershipChannel[]>()
      for (const channel of data.groups.flatMap((group) => group.channels)) {
        const server = parseRef(channel.ref).server
        const channels = channelsByServer.get(server) ?? []
        channels.push({ id: channel.ref, channelId: channel.id, name: channel.name, type: channel.type, visibility: channel.visibility, canLeave: channel.visibility === "private" && !!channel.id })
        channelsByServer.set(server, channels)
      }
      return { servers: data.servers.map((server) => ({ ...server, channels: channelsByServer.get(server.handle) ?? [] })), ...read.proof }
    },
  })
  const mutation = useMutation({
    mutationKey,
    mutationFn: async ({ target, confirmation, view }: LeaveIntent) => {
      view()
      assertBotDirectoryCommandCurrent(client, confirmation)
      if (captureBotDirectoryCommand(client, queryKey) !== confirmation) throw new DOMException("Retired membership read", "AbortError")
      const ref = encodeURIComponent(target.ref)
      await origin.fetch<void>(target.kind === "server"
        ? `/api/community/servers/resolve/leave?server=${ref}`
        : `/api/community/channels/resolve/members/self?ref=${ref}`,
      { method: target.kind === "server" ? "POST" : "DELETE", signal: view.signal, assertActive: view, headers: { [COMMUNITY_BOT_ACTOR_HEADER]: botId } })
      view()
    },
    onSuccess: async (_, { target, confirmation, view }) => {
      view()
      if (origin.registry) await retireBotDirectoryScopes(origin.registry, target.kind === "server"
        ? [{ kind: "bot-server", botId, id: target.id }]
        : [{ kind: "bot-channel", botId, id: target.resourceId! }], confirmation).catch(error => console.error("Bot membership retirement failed", error))
      void client.invalidateQueries({ queryKey }).catch(() => undefined)
    },
  })
  const leave = async (target: BotMembershipTarget) => {
    if (client.isMutating({ mutationKey })) return false
    const assert = source.capture()
    assert()
    const confirmation = captureBotDirectoryCommand(client, queryKey)
    const data = confirmation.state.data as Data
    const allowed = target.kind === "server" ? data.servers.some(server => server.id === target.id && server.handle === target.ref && server.canLeave === true)
      : data.servers.some(server => server.channels.some(channel => channel.id === target.id && channel.id === target.ref && !!channel.channelId && channel.channelId === target.resourceId && channel.visibility === "private" && channel.canLeave === true))
    if (!allowed) throw new DOMException("Membership target is not confirmed", "AbortError")
    await mutation.mutateAsync({ target, confirmation, view: assert })
    assert()
    return true
  }
  return { ...query, pending, leave, capture: source.capture,
    confirmed: query.isFetchedAfterMount && query.isSuccess && !query.isFetching && query.data?.observed === true }
}
