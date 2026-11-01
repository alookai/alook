import { forumTagFromUrl, readForumTagSelection } from "./forum-tag-selection"
import { noop, QueryObserver, type QueryClient } from "@tanstack/react-query"
import { conversationEntryOptions } from "./conversation-entry"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { channelMembershipKey } from "@/lib/community-db/schema"
import { resolveCommunityModulePlan } from "./community-route"
import { prefetchForHref, navigationForHref } from "@/lib/observability/context"
import { systemNotificationHref } from "./system-notification-route"

function cachedNavigationTarget(queryClient: QueryClient, href: string) {
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
  return { channelId, serverId }
}

export function cachedConversationNavigationHref(queryClient: QueryClient, viewerUserId: string, channelId: string) {
  const registry = getCommunityDbRegistry(queryClient)
  if (registry?.accountId !== viewerUserId || registry.sessionViewer() !== viewerUserId) return
  const channel = registry.collections.channels.get(channelId)
  if (!channel) return
  const href = channel.type === "dm" && channel.serverId === null
    ? systemNotificationHref({ kind: "dm", channelId })
    : channel.type !== "dm" && channel.serverId
      ? systemNotificationHref({ kind: "server", channelId, serverId: channel.serverId })
      : undefined
  return href && cachedNavigationTarget(queryClient, href) ? href : undefined
}

export function prepareNavigationMetadata(queryClient: QueryClient, href: string, intent: "prefetch" | "foreground") {
  const target = cachedNavigationTarget(queryClient, href)
  if (!target) return
  const { channelId, serverId } = target
  const action = intent === "prefetch" ? prefetchForHref(href) : navigationForHref(href)
  const search = new URL(href, "https://alook.test").searchParams
  const anchorMessageId = search.get("msg")
  const channel = getCommunityDbRegistry(queryClient)?.collections.channels.get(channelId)
  let tag: string | null = null
  if (channel?.type === "forum") {
    let stored = "All"
    try { if (typeof window !== "undefined") stored = readForumTagSelection(window.localStorage, channelId) } catch {}
    const selected = forumTagFromUrl(search.get("tag")) ?? stored
    tag = selected === "All" ? null : selected
  }
  const options = conversationEntryOptions(queryClient, { serverId, channelId, anchorMessageId, tag }, { action, reason: intent })
  const observer = new QueryObserver(queryClient, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(noop)
  return queryClient.query({ ...options, select: undefined }).catch(noop).finally(unsubscribe)
}
