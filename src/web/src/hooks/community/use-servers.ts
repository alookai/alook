"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import { isServerOwner } from "@alook/shared"
import type { Server, Category } from "@/components/community/_types"

/**
 * Fetches the sidebar list of servers the current user is in.
 *
 * The API returns raw rows; we transform to the render-ready `Server` shape
 * (with `initial` + `isOwner`) inside the query function so consumers get
 * cache entries that are directly render-usable. `active` is a UI-only flag
 * consumers apply after the fact based on the current-server pointer — it's
 * always `false` in the cache.
 */
type RawServerRow = {
  id: string
  name: string
  icon: string | null
  role?: string
  mentions?: number
}

export type ServersResponse = { servers: Server[] }

// Frozen empty fallback — reused across renders while the query is loading so
// consumers depending on `servers` in a `useEffect` dep array don't re-fire
// per render (a fresh `[]` would churn the reference).
const EMPTY_SERVERS: readonly Server[] = Object.freeze([])

export const serversQueryFn = async (): Promise<ServersResponse> => {
  const data = await apiFetch<{ servers: RawServerRow[] }>("/api/community/servers")
  const servers: Server[] = data.servers.map((s) => ({
    id: s.id,
    name: s.name,
    initial: avatarInitial(s.name),
    active: false,
    // Defensive fallback: the API always projects `mentions` now, but during
    // rolling deploys or from cached stale responses the field could still be
    // absent — treat it as 0 rather than NaN.
    mentions: s.mentions ?? 0,
    isOwner: isServerOwner(s.role),
    icon: s.icon ?? null,
  }))
  return { servers }
}

export function useServers(): UseQueryResult<ServersResponse> & {
  servers: Server[]
} {
  const query = useQuery({
    queryKey: communityKeys.servers(),
    queryFn: serversQueryFn,
  })
  return {
    ...query,
    servers: query.data?.servers ?? (EMPTY_SERVERS as Server[]),
  }
}

// ── Single-server detail ─────────────────────────────────────────────────────

export type ServerDetail = {
  id: string
  name: string
  description: string
  icon: string | null
  ownerId: string
  categories: Category[]
}

export const serverQueryFn = (serverId: string) => () =>
  apiFetch<ServerDetail>(`/api/community/servers/${serverId}`)

/**
 * Fetches the detail (categories + channels) for one server. Pass `null` for
 * "no active server" (including the DM home) — the query stays disabled and
 * no request fires.
 */
export function useServer(
  serverId: string | null,
): UseQueryResult<ServerDetail> & { server: ServerDetail | null } {
  const enabled = !!serverId
  const query = useQuery({
    queryKey: enabled ? communityKeys.server(serverId!) : communityKeys.server("__none__"),
    queryFn: enabled ? serverQueryFn(serverId!) : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  return {
    ...query,
    server: query.data ?? null,
  }
}
