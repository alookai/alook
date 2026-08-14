"use client"

import { useQuery, keepPreviousData, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { InviteRow } from "@/lib/community/models/people"

class StaleReadError extends Error {
  constructor() { super("stale D1 read"); this.name = "StaleReadError" }
}
function throwIfStale<T extends { stale?: boolean }>(v: T): T {
  if (v?.stale) throw new StaleReadError()
  return v
}

/**
 * Fetches the invite list surfaced in the settings tab. The API returns raw
 * rows; we transform to the display shape here so consumers get render-ready
 * cache entries (matching the old context's `InviteRow` mapping).
 */
type RawInvite = {
  id: string
  token: string
  maxUses: number | null
  uses: number
  expiresAt: string | null
  createdAt: string
  creatorId: string | null
  creatorName: string | null
}

export type InvitesResponse = { invites: InviteRow[] }

// Frozen empty fallbacks — see `use-servers.ts` for the rationale.
const EMPTY_INVITES: readonly InviteRow[] = Object.freeze([])

export const invitesQueryFn = (serverId: string) => async (): Promise<InvitesResponse> => {
  const data = await apiFetch<{ invites: RawInvite[] }>(
    `/api/community/servers/${serverId}/invites`,
  )
  const invites: InviteRow[] = data.invites.map((i) => ({
    code: i.token,
    uses: i.uses,
    maxUses: i.maxUses,
    expiresAt: i.expiresAt,
    by: i.creatorName ?? "Unknown",
    creatorId: i.creatorId,
  }))
  return { invites }
}

/**
 * Only surfaces the invite list inside the admin settings tab. Non-admins
 * never see the data — pass `isAdmin=false` to skip the fetch. The server
 * endpoint allows any member (no 4xx), but firing it for members who can't
 * see the UI is wasted bandwidth.
 */
export function useInvites(
  serverId: string | null,
  isAdmin: boolean = true,
): UseQueryResult<InvitesResponse> & { invites: InviteRow[] } {
  const enabled = !!serverId && isAdmin
  const query = useQuery({
    queryKey: enabled ? communityKeys.invites(serverId!) : communityKeys.invites("__none__"),
    queryFn: enabled
      ? invitesQueryFn(serverId!)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
    // Not WS-live — no invite events patch this cache. A short staleTime keeps
    // a re-opened settings tab from re-fetching on every mount without going
    // fully stale.
    staleTime: 60_000,
  })
  return {
    ...query,
    invites: query.data?.invites ?? (EMPTY_INVITES as InviteRow[]),
  }
}

/**
 * Fetches the presence roster for a server — the list of online user ids
 * cached at `communityKeys.presence(serverId)`. WS `presence.update` events
 * live-patch the `useCommunityWsStore.onlineUserIds` set (Step 3); this
 * initial load seeds the same set on server switch.
 */
export type PresenceResponse = { online: string[]; truncated?: boolean; limit?: number }

export const presenceQueryFn = (serverId: string) => () =>
  apiFetch<PresenceResponse & { stale?: boolean }>(`/api/community/servers/${serverId}/presence`).then(throwIfStale)

const EMPTY_ONLINE: readonly string[] = Object.freeze([])
export function usePresence(
  serverId: string | null,
): UseQueryResult<PresenceResponse> & { online: readonly string[] } {
  const enabled = !!serverId
  const query = useQuery({
    queryKey: enabled ? communityKeys.presence(serverId!) : communityKeys.presence("__none__"),
    queryFn: enabled
      ? presenceQueryFn(serverId!)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
    placeholderData: keepPreviousData,
    // WS `presence.update` live-patches the online set, so a remount never
    // needs to re-seed — this fetch is a once-per-server seed. staleTime:
    // Infinity stops the per-switch refetch. refetchOnReconnect is the
    // required backstop: the WS reconnect handler does NOT re-seed presence,
    // so events missed during a socket gap would otherwise leave the roster
    // permanently stale.
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  return {
    ...query,
    // Reuse a frozen empty array so consumers depending on `online` in a
    // hook dep array don't re-fire on every render while data is loading.
    online: query.data?.online ?? EMPTY_ONLINE,
  }
}
