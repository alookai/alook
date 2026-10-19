import { noop, QueryObserver, type QueryClient } from "@tanstack/react-query"
import { conversationEntryOptions } from "./conversation-entry"
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
  const anchorMessageId = new URL(href, "https://alook.test").searchParams.get("msg")
  const options = conversationEntryOptions(queryClient, { serverId, channelId, anchorMessageId }, { action, reason: intent })
  const observer = new QueryObserver(queryClient, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(noop)
  return queryClient.query({ ...options, select: undefined }).catch(noop).finally(unsubscribe)
}
