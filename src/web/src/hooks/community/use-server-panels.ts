"use client"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import type { QueryFunctionContext } from "@tanstack/react-query"

import { useQuery,useQueryClient,useMutationState,keepPreviousData,type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { loadAndSeedProfiles,beginCommunityProfileSeed,writeCommunityProfilePatches } from "@/lib/community/profile-seed"
import { captureCommunityLiveSnapshotToken,assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
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

type InviteResourceRow = Omit<InviteRow, "by">
export type InvitesResponse = { invites: InviteResourceRow[] }

// Frozen empty fallbacks — see `use-servers.ts` for the rationale.
const EMPTY_INVITES: readonly InviteRow[] = Object.freeze([])

export const invitesQueryFn = (serverId: string) => async (context: QueryFunctionContext): Promise<InvitesResponse> => {
  const original = captureCommunityLiveSnapshotToken(context.client)
  const assert = () => assertCommunityLiveSnapshotTokenCurrent(context.client, original, context.signal)
  const snapshot = beginCommunityProfileSeed(original.registry)
  await original.registry?.ready
  assert()
  const data = await apiFetch<{ invites: RawInvite[] }>(
    `/api/community/servers/${serverId}/invites`,
    communityRequestOptions(context.client, original, context.signal, assert),
  )
  assert()
  writeCommunityProfilePatches(data.invites.flatMap((i) => i.creatorId && i.creatorName !== null ? [{ id: i.creatorId, identityAbout: { name: i.creatorName } }] : []), original.registry, { snapshot })
  const invites: InviteResourceRow[] = data.invites.map((i) => ({
    code: i.token,
    uses: i.uses,
    maxUses: i.maxUses,
    expiresAt: i.expiresAt,
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
  const client = useQueryClient()
  const enabled = !!serverId && isAdmin
  const query = useQuery({
    queryKey: enabled ? communityKeys.invites(serverId!) : communityKeys.invites("__none__"),
    queryFn: enabled
      ? invitesQueryFn(serverId!)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
    subscribed: enabled,
    // Not WS-live — no invite events patch this cache. A short staleTime keeps
    // a re-opened settings tab from re-fetching on every mount without going
    // fully stale.
    staleTime: 60_000,
  })
  const profiles = useCanonicalProfilesByUserId(query.data?.invites.flatMap((row) => row.creatorId ? [row.creatorId] : []) ?? [])
  const pending = useMutationState({ filters: { mutationKey: ["community", "invite-revoke"], status: "pending" }, select: (mutation) => mutation.state.variables as { serverId: string; code: string; resource?: unknown } | undefined })
  const resource = client.getQueryCache().find({ queryKey: communityKeys.invites(serverId ?? "__none__"), exact: true })
  const hidden = new Set(pending.filter((intent) => intent?.serverId === serverId && intent.resource === resource).map((intent) => intent!.code))
  const invites = query.data?.invites.filter((row) => !hidden.has(row.code)).map((row) => ({ ...row, by: row.creatorId ? profiles.get(row.creatorId)?.name || "Deleted user" : "Deleted user" }))
  return {
    ...query,
    invites: invites ?? (EMPTY_INVITES as InviteRow[]),
  }
}

/**
 * Fetches the presence roster for a server — the list of online user ids
 * cached at `communityKeys.presence(serverId)`. WS `presence.update` events
 * live-patch the global profile map; this initial load seeds the same map.
 */
export type PresenceResponse = { online: string[]; truncated?: boolean; limit?: number }

export const presenceQueryFn = (serverId: string) => (context: QueryFunctionContext) =>
  loadAndSeedProfiles(
    (origin) => apiFetch<PresenceResponse & { stale?: boolean }>(
      `/api/community/servers/${serverId}/presence`,
      origin,
    ).then(throwIfStale),
    (data) => data.online.map((id) => ({ id, presence: "online" })),
    getCommunityDbRegistry(context.client),
    context.signal,
  )

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
