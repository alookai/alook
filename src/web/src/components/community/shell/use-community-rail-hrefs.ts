"use client"

import { getServerDirectoryWindow } from "@/lib/community/server-directory-window"
import { useCallback, useRef, useSyncExternalStore } from "react"
import type { Breakpoint } from "@/hooks/use-mobile"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { lastChannelKey, resolveCommunityLandingHref } from "@/lib/community/last-channel"
import { lastMeLocationKey } from "@/lib/community/last-me-location"
import { readNavigationMemory, subscribeNavigationMemory } from "@/lib/community/navigation-memory"

type RailHrefsSnapshot = { homeHref: string; serverHrefs: Record<string, string> }

function sameRailHrefsSnapshot(left: RailHrefsSnapshot | null, right: RailHrefsSnapshot): boolean {
  if (!left || left.homeHref !== right.homeHref) return false
  const leftKeys = Object.keys(left.serverHrefs)
  const rightKeys = Object.keys(right.serverHrefs)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of rightKeys) {
    if (left.serverHrefs[key] !== right.serverHrefs[key]) return false
  }
  return true
}

function channelStructureSignature(channel: {
  serverId?: string | null
  type?: string
  pending?: boolean
}): string {
  return `${channel.serverId ?? ""}\0${channel.type ?? ""}\0${channel.pending ? "1" : "0"}`
}

export function communityServerLandingHref(
  registry: CommunityDbRegistry | null, id: string, last: string | null, breakpoint: Breakpoint, canonicalChannelIds?: readonly string[],
) {
  const complete = Boolean(getServerDirectoryWindow(registry, id))
  const channelIds = registry && complete
    ? canonicalChannelIds ?? Array.from(registry.collections.channels.values())
      .filter((channel) => channel.serverId === id && channel.type !== "thread" && !channel.pending)
      .map((channel) => channel.id)
    : []
  return resolveCommunityLandingHref({ serverId: id, channelIds, last, breakpoint })
}

export function useCommunityRailHrefs(servers: readonly { id: string }[], breakpoint: Breakpoint) {
  const registry = useOptionalCommunityDbRegistry()
  const snapshotRef = useRef<RailHrefsSnapshot | null>(null)
  const serverSnapshotRef = useRef<RailHrefsSnapshot | null>(null)
  const subscribe = useCallback((notify: () => void) => {
    const memory = subscribeNavigationMemory(notify)
    const serverChanges = registry?.collections.servers.subscribeChanges(() => notify())
    const structuralById = new Map<string, string>()
    for (const channel of registry?.collections.channels.values() ?? []) {
      structuralById.set(channel.id, channelStructureSignature(channel))
    }
    const channelChanges = registry?.collections.channels.subscribeChanges((changes) => {
      if (!Array.isArray(changes)) {
        notify()
        return
      }
      let structural = false
      for (const change of changes as Array<{
        type?: string
        key?: string
        value?: { id?: string; serverId?: string | null; type?: string; pending?: boolean }
      }>) {
        const key = change.key ?? change.value?.id
        if (!key) {
          structural = true
          continue
        }
        if (change.type === "delete") {
          if (structuralById.delete(key)) structural = true
          continue
        }
        if (!change.value) {
          structural = true
          continue
        }
        const nextSig = channelStructureSignature(change.value)
        if (structuralById.get(key) !== nextSig) {
          structuralById.set(key, nextSig)
          structural = true
        }
      }
      if (structural) notify()
    })
    return () => {
      memory()
      serverChanges?.unsubscribe()
      channelChanges?.unsubscribe()
    }
  }, [registry])
  const getSnapshot = useCallback((): RailHrefsSnapshot => {
    const channelsByServer = new Map<string, string[]>()
    for (const channel of registry?.collections.channels.values() ?? []) {
      if (!channel.serverId || channel.type === "thread" || channel.pending) continue
      const ids = channelsByServer.get(channel.serverId) ?? []
      ids.push(channel.id)
      channelsByServer.set(channel.serverId, ids)
    }
    const next: RailHrefsSnapshot = {
      homeHref: resolveCommunityLandingHref({ serverId: null, last: readNavigationMemory(lastMeLocationKey()), breakpoint }),
      serverHrefs: Object.fromEntries(servers.map(({ id }) => [id,
        communityServerLandingHref(registry, id, readNavigationMemory(lastChannelKey(id)), breakpoint, channelsByServer.get(id) ?? []),
      ])),
    }
    if (sameRailHrefsSnapshot(snapshotRef.current, next)) return snapshotRef.current!
    snapshotRef.current = next
    return next
  }, [registry, servers, breakpoint])
  const getServerSnapshot = useCallback((): RailHrefsSnapshot => {
    const next: RailHrefsSnapshot = {
      homeHref: resolveCommunityLandingHref({ serverId: null, last: null, breakpoint }),
      serverHrefs: Object.fromEntries(servers.map(({ id }) => [id,
        resolveCommunityLandingHref({ serverId: id, last: null, breakpoint }),
      ])),
    }
    if (sameRailHrefsSnapshot(serverSnapshotRef.current, next)) return serverSnapshotRef.current!
    serverSnapshotRef.current = next
    return next
  }, [servers, breakpoint])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
