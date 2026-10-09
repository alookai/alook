import { noop, type QueryClient } from "@tanstack/react-query"
import { channelMetadataOptions, isChannelMetadataTokenCurrent, type ChannelMetadataResource } from "@/hooks/community/channel-metadata"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { channelMembershipKey } from "@/lib/community-db/schema"
import { resolveCommunityModulePlan } from "./community-route"
import { prefetchForHref, navigationForHref } from "@/lib/observability/context"

export function prepareNavigationMetadata(queryClient: QueryClient, href: string, intent: "prefetch" | "foreground") {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.accountId || !registry.runtime.lifecycle.get().active) return
  const main = resolveCommunityModulePlan(href).main
  if (main.kind !== "dm" && main.kind !== "server-conversation") return
  const channelId = main.kind === "dm" ? main.dmId : main.leafId
  const serverId = main.kind === "dm" ? null : main.serverId
  const channel = registry.collections.channels.get(channelId)
  if (!channel || channel.pending || channel.archived || (channel.serverId ?? null) !== serverId
    || (main.kind === "dm") !== (channel.type === "dm")
    || !registry.collections.channelMemberships.has(channelMembershipKey(channelId, registry.accountId, "access"))
    || registry.runtime.ws.actions.isChannelAccessRevoked(channelId, serverId)) return
  const action = intent === "prefetch" ? prefetchForHref(href) : navigationForHref(href)
  const options = channelMetadataOptions(queryClient, serverId, channelId, { action, reason: intent })
  const cached = queryClient.getQueryData<ChannelMetadataResource>(options.queryKey)
  return queryClient.query({ ...options,
    staleTime: cached?.readProof && isChannelMetadataTokenCurrent(cached.readProof) ? Infinity : 0 }).catch(noop)
}
