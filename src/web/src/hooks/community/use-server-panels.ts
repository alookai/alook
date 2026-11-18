"use client"
import { loadAndSeedProfiles } from "@/lib/community/account-cache-lifecycle"
import { CommunityInvitesReadSchema, CommunityPresenceReadSchema, type CommunityPresenceRead } from "@alook/shared"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import type { QueryFunctionContext } from "@tanstack/react-query"

import { useQuery,useQueryClient,useMutationState,keepPreviousData,type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityUserProfilePatch } from "@/lib/community/profile-seed"
import { captureCommunityLiveSnapshotToken,assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"

import { useCanonicalProfilesProjection } from "@/lib/community-db/projections"
import { communityKeys } from "@/lib/query-keys"
import type { InviteRow } from "@/lib/community/models/people"
import type { InvitesWindow } from "@/lib/community/directory-window-persistence"

class StaleReadError extends Error {
  constructor() { super("stale D1 read"); this.name = "StaleReadError" }
}
function throwIfStale<T extends { stale?: boolean }>(v: T): T {
  if (v?.stale) throw new StaleReadError()
  return v
}

type InviteResourceRow = Omit<InviteRow, "by">
export type InvitesResponse = InvitesWindow

const EMPTY_INVITES: readonly InviteRow[] = Object.freeze([])

export const invitesQueryFn = (serverId: string) => async (context: QueryFunctionContext): Promise<InvitesResponse> => {
  const original = captureCommunityLiveSnapshotToken(context.client)
  const assert = () => assertCommunityLiveSnapshotTokenCurrent(context.client, original, context.signal)
  await original.registry?.ready
  const auxiliaryReadEpoch = await original.registry?.captureAuxiliaryReadEpoch()
  assert()
  const data = await loadAndSeedProfiles(
    origin => apiFetch<unknown>(`/api/community/servers/${serverId}/invites`, { ...origin, signal: context.signal }).then(value => CommunityInvitesReadSchema.parse(value)),
    value => {
      if (value.serverId !== serverId || value.resources.viewerId !== original.registry!.accountId) throw new Error("Invite resource scope mismatch")
      return value.resources.profiles.map(profile => communityUserProfilePatch(profile.id, profile))
    }, original.registry, context.signal, original,
  )
  const invites: InviteResourceRow[] = data.invites.map((i) => ({
    code: i.token,
    uses: i.uses,
    maxUses: i.maxUses,
    expiresAt: i.expiresAt,
    creatorId: i.creatorId,
  }))
  return { invites, observed: true, ...(auxiliaryReadEpoch ? { auxiliaryReadEpoch } : {}) }
}

export function useInvites(
  serverId: string | null,
  enabled: boolean,
): Omit<UseQueryResult<InvitesResponse>, "data"> & { data: InvitesResponse | undefined; invites: InviteRow[]; observed: boolean; loading: boolean; failed: boolean; refreshFailed: boolean; isCurrentRead: () => boolean } {
  const client = useQueryClient()
  const admitted = !!serverId && enabled
  const query = useQuery({
    queryKey: admitted ? communityKeys.invites(serverId!) : communityKeys.invites("__none__"),
    queryFn: admitted
      ? invitesQueryFn(serverId!)
      : (() => Promise.reject(new Error("disabled"))),
    enabled: admitted,
    subscribed: admitted,

    staleTime: 60_000,
  })
  const profileProjection = useCanonicalProfilesProjection(query.data?.invites.flatMap((row) => row.creatorId ? [row.creatorId] : []) ?? [])
  const profiles = profileProjection.data
  const pending = useMutationState({ filters: { mutationKey: ["community", "invite-revoke"], status: "pending" }, select: (mutation) => mutation.state.variables as { serverId: string; code: string; resource?: unknown } | undefined })
  const resource = client.getQueryCache().find({ queryKey: communityKeys.invites(serverId ?? "__none__"), exact: true })
  const hidden = new Set(pending.filter((intent) => intent?.serverId === serverId && intent.resource === resource).map((intent) => intent!.code))
  const invites = query.data?.invites.filter((row) => !hidden.has(row.code) && (row.creatorId === null || profileProjection.resourceProfiles.has(row.creatorId))).map((row) => ({ ...row, by: row.creatorId ? profiles.get(row.creatorId)!.name || "Deleted user" : "Deleted user" }))
  const complete = !!query.data && profileProjection.isReady && profileProjection.isEnabled && !profileProjection.isError
    && query.data.invites.every(row => row.creatorId === null || profileProjection.resourceProfiles.has(row.creatorId))
  const failed = admitted && !complete && (query.isError || profileProjection.isError || !!query.data && profileProjection.isReady)
  const isCurrentRead = () => {
    const state = client.getQueryState<InvitesResponse>(communityKeys.invites(serverId ?? "__none__"))
    return admitted && complete && getCommunityDbRegistry(client) === profileProjection.registry && state?.status === "success"
      && !state.isInvalidated && state.data === query.data && state.data?.observed === true
  }
  return {
    ...query,
    data: admitted && complete ? query.data : undefined,
    invites: admitted ? invites ?? (EMPTY_INVITES as InviteRow[]) : (EMPTY_INVITES as InviteRow[]),
    observed: isCurrentRead(), isCurrentRead,
    loading: admitted && !complete && !failed,
    failed,
    refreshFailed: complete && query.isError && !query.isFetching,
  }
}

export type PresenceResponse = CommunityPresenceRead

export const presenceQueryFn = (serverId: string) => (context: QueryFunctionContext) =>
  loadAndSeedProfiles(
    (origin) => apiFetch<unknown>(
      `/api/community/servers/${serverId}/presence`,
      origin,
    ).then(data => throwIfStale(CommunityPresenceReadSchema.parse(data))),
    data => [...data.online.map(id => ({ id, presence: "online" as const })), ...data.offline.map(id => ({ id, presence: "offline" as const }))],
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
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  return {
    ...query,

    online: query.data?.online ?? EMPTY_ONLINE,
  }
}
