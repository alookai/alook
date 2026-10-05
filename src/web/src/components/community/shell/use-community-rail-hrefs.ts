"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"
import type { Breakpoint } from "@/hooks/use-mobile"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { lastChannelKey, resolveCommunityLandingHref } from "@/lib/community/last-channel"
import { lastMeLocationKey } from "@/lib/community/last-me-location"
import { readNavigationMemory, subscribeNavigationMemory } from "@/lib/community/navigation-memory"

export function communityServerLandingHref(
  registry: CommunityDbRegistry | null, id: string, last: string | null, breakpoint: Breakpoint, canonicalChannelIds?: readonly string[],
) {
  const complete = registry?.collections.servers.get(id)?.detailComplete === true
  const channelIds = registry && complete
    ? canonicalChannelIds ?? Array.from(registry.collections.channels.values())
      .filter((channel) => channel.serverId === id && channel.type !== "thread" && !channel.pending)
      .map((channel) => channel.id)
    : []
  return resolveCommunityLandingHref({ serverId: id, channelIds, last, breakpoint })
}

export function useCommunityRailHrefs(servers: readonly { id: string }[], breakpoint: Breakpoint) {
  const registry = useOptionalCommunityDbRegistry()
  const subscribe = useCallback((notify: () => void) => {
    const memory = subscribeNavigationMemory(notify)
    const serverChanges = registry?.collections.servers.subscribeChanges(notify)
    const channelChanges = registry?.collections.channels.subscribeChanges(notify)
    return () => {
      memory()
      serverChanges?.unsubscribe()
      channelChanges?.unsubscribe()
    }
  }, [registry])
  const getSnapshot = useCallback(() => {
    const channelsByServer = new Map<string, string[]>()
    for (const channel of registry?.collections.channels.values() ?? []) {
      if (!channel.serverId || channel.type === "thread" || channel.pending) continue
      const ids = channelsByServer.get(channel.serverId) ?? []
      ids.push(channel.id)
      channelsByServer.set(channel.serverId, ids)
    }
    return JSON.stringify({
      homeHref: resolveCommunityLandingHref({ serverId: null, last: readNavigationMemory(lastMeLocationKey()), breakpoint }),
      serverHrefs: Object.fromEntries(servers.map(({ id }) => [id,
        communityServerLandingHref(registry, id, readNavigationMemory(lastChannelKey(id)), breakpoint, channelsByServer.get(id) ?? []),
      ])),
    })
  }, [registry, servers, breakpoint])
  const getServerSnapshot = useCallback(() => JSON.stringify({
    homeHref: resolveCommunityLandingHref({ serverId: null, last: null, breakpoint }),
    serverHrefs: Object.fromEntries(servers.map(({ id }) => [id,
      resolveCommunityLandingHref({ serverId: id, last: null, breakpoint }),
    ])),
  }), [servers, breakpoint])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return useMemo(() => JSON.parse(snapshot) as { homeHref: string; serverHrefs: Record<string, string> }, [snapshot])
}
