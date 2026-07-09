"use client"

import { useMemo } from "react"
import { useQueries } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useServers, serverQueryFn, type ServerDetail } from "./use-servers"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
import type { Server } from "@/components/community/_types"

/**
 * Pure — flattens each server's `categories[].channels` into one `channels`
 * array per server. A server whose detail hasn't loaded yet (or is
 * genuinely still loading) contributes an empty `channels` array rather than
 * being omitted or crashing — `resolveChannelRefBase` then simply can't
 * resolve into it yet (falls back to plain/muted text upstream), and the
 * directory backfills once the detail query resolves.
 */
export function buildChannelRefDirectory(
  servers: Server[],
  detailsById: Record<string, ServerDetail | undefined>,
): ChannelRefDirectory {
  return servers.map((s) => {
    const detail = detailsById[s.id]
    const channels = detail?.categories?.flatMap((c) => c.channels.map((ch) => ({ id: ch.id, name: ch.name }))) ?? []
    return { id: s.id, name: s.name, channels }
  })
}

/**
 * Directory of every channel-ref-resolvable server + channel the current
 * user is a member of. Fetches every member server's channel list in
 * parallel via `useQueries` (reusing `serverQueryFn`/`communityKeys.server`
 * so the cache is shared with any already-mounted single-server `useServer`
 * call), then flattens via `buildChannelRefDirectory`.
 *
 * Scope decision: eagerly resolves refs to ANY server the user is a member
 * of, not just the currently open one — simpler and more correct than
 * lazily fetching only the referenced server, at the cost of fetching every
 * member server's channel list as soon as a channel-ref pill is on screen
 * (bounded, cached, parallel).
 */
export function useChannelRefDirectory(): {
  directory: ChannelRefDirectory
  isLoading: boolean
} {
  const { servers } = useServers()

  const results = useQueries({
    queries: servers.map((s) => ({
      queryKey: communityKeys.server(s.id),
      queryFn: serverQueryFn(s.id),
    })),
  })

  const detailsById = useMemo(() => {
    const map: Record<string, ServerDetail | undefined> = {}
    servers.forEach((s, i) => {
      map[s.id] = results[i]?.data
    })
    return map
  }, [servers, results])

  const directory = useMemo(
    () => buildChannelRefDirectory(servers, detailsById),
    [servers, detailsById],
  )

  const isLoading = results.some((r) => r.isLoading)

  return { directory, isLoading }
}
