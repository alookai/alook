import type { Query } from "@tanstack/react-query"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { isBotDirectoryWindowKey } from "./bot-directory-window"
import type { AuxiliaryWindowScope } from "./auxiliary-window-contract"

function matches(query: Query, scope: AuxiliaryWindowScope) {
  const key = query.queryKey
  if (!isBotDirectoryWindowKey(key)) return false
  if (scope.kind === "server-admin") return key[1] === "servers" && key[2] === scope.id
  if (scope.kind === "server-resource" && key[1] === "servers") return key[2] === scope.id
  if (scope.kind === "channel-resource" && key[1] === "servers")
    return (query.state.data as { channels?: Array<{ id: string }> } | undefined)?.channels?.some(channel => channel.id === scope.id) === true
  if (key[1] !== "bot") return false
  if (scope.kind === "bot") return key[2] === scope.id
  if (scope.kind === "bot-memberships") return key[2] === scope.id && key[3] === "memberships"
  if (scope.kind === "server-resource" || scope.kind === "channel-resource") {
    const data = query.state.data as { serverId?: string | null; marked?: Array<{ serverId: string | null; channelId: string; parentChannelId?: string | null }>; servers?: Array<{ id: string; channels: Array<{ channelId: string }> }> } | undefined
    if (key[3] === "marks") return data?.marked?.some(mark => scope.kind === "server-resource" ? mark.serverId === scope.id : mark.channelId === scope.id || mark.parentChannelId === scope.id) === true
    if (key[3] === "notification-settings") return scope.kind === "channel-resource" ? key[4] === "channel" && key[5] === scope.id
      : key[4] === "server" && key[5] === scope.id || key[4] === "channel" && (data?.serverId === undefined || data.serverId === scope.id)
    return key[3] === "memberships" && data?.servers?.some(server => scope.kind === "server-resource" ? server.id === scope.id : server.channels.some(channel => channel.channelId === scope.id)) === true
  }
  if (scope.kind === "bot-server" || scope.kind === "bot-channel") {
    if (key[2] !== scope.botId || key[3] !== "notification-settings") return false
    if (key[4] === (scope.kind === "bot-server" ? "server" : "channel") && key[5] === scope.id) return true
    const parent = (query.state.data as { serverId?: string | null } | undefined)?.serverId
    return scope.kind === "bot-server" && key[4] === "channel" && (parent === undefined || parent === scope.id)
  }
  if (scope.kind === "message" && key[3] === "marks") {
    const data = query.state.data as { marked?: Array<{ m: { id: string } }> } | undefined
    return data?.marked?.some(mark => mark.m.id === scope.id) === true
  }
  return false
}

export function retireBotDirectoryScopes(registry: CommunityDbRegistry, requested: readonly AuxiliaryWindowScope[], keepQuery?: Query) {
  if (!registry.runtime.lifecycle.get().active || !requested.length) return Promise.resolve()
  const scopes = [...requested, ...requested.flatMap((scope): AuxiliaryWindowScope[] => scope.kind === "bot-server" || scope.kind === "bot-channel"
    ? [{ kind: "bot-memberships", id: scope.botId }] : [])]
  for (const query of registry.queryClient.getQueryCache().getAll()) {
    if (isBotDirectoryWindowKey(query.queryKey) && query.queryKey[1] === "servers" && query.state.fetchStatus === "fetching"
      && requested.some(scope => scope.kind === "channel-resource") && !scopes.some(scope => matches(query, scope))) void query.cancel({ revert: true })
    if (query.queryKey[1] === "bot" && query.queryKey[3] === "marks" && query.state.fetchStatus === "fetching"
      && requested.some(scope => scope.kind === "message" || scope.kind === "server-resource" || scope.kind === "channel-resource") && !scopes.some(scope => matches(query, scope))) void query.cancel({ revert: true })
    if (!scopes.some(scope => matches(query, scope))) continue
    if (query === keepQuery) query.setState({ data: undefined, dataUpdatedAt: 0 })
    else {
      void query.cancel({ revert: false })
      query.setState({ data: undefined, dataUpdatedAt: 0, status: "error", fetchStatus: "idle", isInvalidated: false,
        error: new DOMException("Retired directory scope", "AbortError") })
    }
  }
  return registry.retireAuxiliaryDisk(scopes)
}

export function retireBotServerDirectories(registry: CommunityDbRegistry, serverId: string) {
  const botIds = new Set<string>()
  for (const query of registry.queryClient.getQueryCache().getAll()) {
    const key = query.queryKey
    if (!isBotDirectoryWindowKey(key) || key[1] !== "bot") continue
    const data = query.state.data as { serverId?: string | null; servers?: Array<{ id: string }> } | undefined
    const containsServer = key[3] === "memberships" && data?.servers?.some(server => server.id === serverId)
    if (key[3] === "memberships" && !containsServer && query.state.fetchStatus === "fetching") void query.cancel({ revert: true })
    if (key[3] === "notification-settings" && (key[4] === "server" && key[5] === serverId
      || key[4] === "channel" && (data?.serverId === undefined || data.serverId === serverId))
      || containsServer) botIds.add(key[2] as string)
  }
  return retireBotDirectoryScopes(registry, [{ kind: "server-resource", id: serverId }, ...[...botIds].map(botId => ({ kind: "bot-server" as const, botId, id: serverId }))])
}

export function retireBotChannelDirectories(registry: CommunityDbRegistry, channelId: string) {
  const botIds = new Set<string>()
  for (const query of registry.queryClient.getQueryCache().getAll()) {
    const key = query.queryKey
    if (!isBotDirectoryWindowKey(key) || key[1] !== "bot") continue
    const data = query.state.data as { servers?: Array<{ channels: Array<{ channelId: string }> }> } | undefined
    const containsChannel = key[3] === "memberships" && data?.servers?.some(server => server.channels.some(channel => channel.channelId === channelId))
    if (key[3] === "memberships" && !containsChannel && query.state.fetchStatus === "fetching") void query.cancel({ revert: true })
    if (key[3] === "notification-settings" && key[4] === "channel" && key[5] === channelId || containsChannel) botIds.add(key[2] as string)
  }
  return retireBotDirectoryScopes(registry, [{ kind: "channel-resource", id: channelId }, ...[...botIds].map(botId => ({ kind: "bot-channel" as const, botId, id: channelId }))])
}
