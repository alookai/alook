"use client"

import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { COMMUNITY_BOT_ACTOR_HEADER, parseRef, type CommunityCliChannelGroup } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityMutationOrigin } from "./community-origin"
import { useCommunityViewSource } from "./use-community-view-source"

type BotMembershipChannel = { id: string; name: string; type: "text" | "forum"; canLeave: boolean }
type BotMembershipServer = { id: string; name: string; handle: string; icon: string | null; canLeave: boolean; channels: BotMembershipChannel[] }
export type BotMembershipTarget = { kind: "channel" | "server"; id: string; ref: string; name: string; serverName?: string; publicChannelName?: string }
type Memberships = { groups: CommunityCliChannelGroup[]; servers: Omit<BotMembershipServer, "channels">[] }

export function useBotMemberships(botId: string, open: boolean) {
  const client = useQueryClient()
  const origin = useCommunityMutationOrigin()
  const source = useCommunityViewSource(`bot-memberships:${botId}`, open)
  const queryKey = communityKeys.botMemberships(botId)
  const mutationKey = [...queryKey, "leave"]
  const pending = useIsMutating({ mutationKey }) > 0
  const query = useQuery({
    queryKey,
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const data = await origin.fetch<Memberships>("/api/community/servers/channels", { signal, headers: { [COMMUNITY_BOT_ACTOR_HEADER]: botId } })
      const channelsByServer = new Map<string, BotMembershipChannel[]>()
      for (const channel of data.groups.flatMap((group) => group.channels)) {
        const server = parseRef(channel.ref).server
        const channels = channelsByServer.get(server) ?? []
        channels.push({ id: channel.ref, name: channel.name, type: channel.type, canLeave: channel.visibility === "private" })
        channelsByServer.set(server, channels)
      }
      return { servers: data.servers.map((server) => ({ ...server, channels: channelsByServer.get(server.handle) ?? [] })) }
    },
  })
  const mutation = useMutation({
    mutationKey,
    meta: { observabilityAction: "community.command" },
    mutationFn: (target: BotMembershipTarget) => {
      const ref = encodeURIComponent(target.ref)
      return origin.fetch<void>(target.kind === "server"
        ? `/api/community/servers/resolve/leave?server=${ref}`
        : `/api/community/channels/resolve/members/self?ref=${ref}`,
      { method: target.kind === "server" ? "POST" : "DELETE", headers: { [COMMUNITY_BOT_ACTOR_HEADER]: botId } })
    },
    onSuccess: () => client.invalidateQueries({ queryKey }),
  })
  const leave = async (target: BotMembershipTarget) => {
    if (client.isMutating({ mutationKey })) return false
    const assert = source.capture()
    assert()
    await mutation.mutateAsync(target)
    assert()
    return true
  }
  return { ...query, pending, leave, capture: source.capture }
}
