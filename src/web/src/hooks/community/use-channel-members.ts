"use client"
import { completeCommunityPublication } from "@/lib/community-db/sync"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback,useMemo } from "react"
import { QueryObserver,useMutation,useQuery,useQueryClient,type QueryClient,type QueryFunctionContext,type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { type CommunityMembersRead, type CommunityRole, type CommunityMemberRelation, type CommunityResourceProfile } from "@alook/shared"
import type { CommunityProfile, CommunityUserCore, Presence } from "@/lib/community/models/people"
import { fetchAllServerMembers } from "./fetch-all-server-members"

import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { getMemberReadState, useCanonicalProfilesProjection, useServerMemberProjection, useChannelRosterProjection } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken,assertCommunityLiveSnapshotTokenCurrent,publishCommunityChannelMembersSnapshot,retireCommunityChannelReading,setCanonicalCommunityChannelMember } from "@/lib/community-db/sync"
import { channelMembershipKey, type ChannelMembershipRow } from "@/lib/community-db/schema"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { useCommunityMutationOrigin } from "./community-origin"
import { useCommunityViewSource } from "./use-community-view-source"
import type { ChannelRosterWindow, AddableMembersWindow } from "@/lib/community/directory-window-persistence"

export type ChannelMember = CommunityUserCore & Pick<CommunityMemberRelation, "userId" | "isCreator"> & Pick<CommunityResourceProfile, "statusEmoji" | "statusText"> & {
  id: string
  sub: string
  role: CommunityRole | null
  status: Presence
  source: NonNullable<ChannelMembershipRow["source"]>
}

type AddableMember = Pick<ChannelMember, "userId" | "avatar" | "avatarVersion"> & { [Field in "name" | "discriminator"]: ChannelMember[Field] | null }

function channelMembersOptions(client: QueryClient, channelId: string, serverId?: string, relation?: "access" | "notify") {
  const queryKey = communityKeys.channelMembers(channelId, relation ?? "access")
  return {
    queryKey,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ChannelRosterWindow> => {
      const token = captureCommunityLiveSnapshotToken(client, channelId), registry = token.registry!
      const resource = client.getQueryCache().find({ queryKey, exact: true })
      const assert = () => {
        assertCommunityLiveSnapshotTokenCurrent(client, token, signal)
        if (resource && client.getQueryCache().find({ queryKey, exact: true }) !== resource) throw new DOMException("Retired channel roster", "AbortError")
      }
      assert()
      await registry.ready
      await Promise.all([registry.collections.channelMemberships.preload(), registry.collections.serverMemberships.preload()])
      const auxiliaryReadEpoch = await registry.captureAuxiliaryReadEpoch()
      assert()
      const channel = registry.collections.channels.get(channelId)
      const scopeId = serverId ?? channel?.serverId ?? (channel?.type === "dm" ? null : undefined)
      if (scopeId === undefined) throw new DOMException("Missing channel roster scope", "AbortError")
      const dimension = relation ?? "access"
      const response = await apiFetch<CommunityMembersRead>("/api/community/channels/" + encodeURIComponent(channelId) + "/members?relation=" + dimension, communityRequestOptions(client, token, signal, assert))
      assert()
      const resources = response
      await publishCommunityChannelMembersSnapshot(client, scopeId, channelId, dimension, resources.members, { token, signal }, resources.profiles)
      assert()
      return { serverId: scopeId, relation: dimension, creatorIds: resources.members.filter(member => member.isCreator).map(member => member.userId), members: resources.members.map(({ memberId, userId }) => ({ id: memberId ?? userId, userId })), observed: true, ...(auxiliaryReadEpoch ? { auxiliaryReadEpoch } : {}) }
    },
  }
}

async function readChannelRoster(client: QueryClient, channelId: string, serverId: string, signal: AbortSignal) {
  const original = captureCommunityLiveSnapshotToken(client, channelId)
  const assert = () => assertCommunityLiveSnapshotTokenCurrent(client, original, signal)
  assert()
  const auxiliaryReadEpoch = await original.registry!.captureAuxiliaryReadEpoch()
  assert()
  const options = { ...channelMembersOptions(client, channelId, serverId), ...(auxiliaryReadEpoch ? { staleTime: 0 } : {}) }
  const observer = new QueryObserver(client, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(() => undefined)
  signal.addEventListener("abort", unsubscribe, { once: true })
  try {
    const window = await client.query({ ...options, select: undefined })
    assert()
    return window
  } finally { signal.removeEventListener("abort", unsubscribe); unsubscribe() }
}

async function addableMembersQueryFn(serverId: string, channelId: string, context: QueryFunctionContext): Promise<AddableMembersWindow> {
  const original = captureCommunityLiveSnapshotToken(context.client, channelId)
  assertCommunityLiveSnapshotTokenCurrent(context.client, original, context.signal)
  const auxiliaryReadEpoch = await original.registry!.captureAuxiliaryReadEpoch()
  assertCommunityLiveSnapshotTokenCurrent(context.client, original, context.signal)
  const [serverMembers, roster] = await Promise.all([
    fetchAllServerMembers(context.client, serverId, context.signal),
    readChannelRoster(context.client, channelId, serverId, context.signal),
  ])
  assertCommunityLiveSnapshotTokenCurrent(context.client, original, context.signal)
  const present = new Set(roster.members.map(member => member.userId))
  return { serverId, relation: roster.relation, members: serverMembers.filter(member => !present.has(member.userId)).map(({ id, userId }) => ({ id, userId })), observed: true, ...(auxiliaryReadEpoch ? { auxiliaryReadEpoch } : {}) }
}

type ChannelMembersResult = Omit<UseQueryResult<ChannelRosterWindow>, "data"> & {
  data: { members: ChannelMember[] } | undefined
  members: ChannelMember[]; profiles: ReadonlyMap<string, CommunityProfile>; loading: boolean; failed: boolean; observed: boolean; isCurrentRead: () => boolean
}

export function useChannelMembers(channelId: string, enabled = true, serverId?: string, relation?: "access" | "notify"): ChannelMembersResult {
  const client = useQueryClient()
  const active = enabled && !!channelId
  const query = useQuery({ ...channelMembersOptions(client, channelId, serverId, relation), enabled: active, subscribed: active })
  const rosterProjection = useChannelRosterProjection(active ? channelId : "", query.data?.relation ?? relation ?? "access")
  const roster = rosterProjection.data
  const profileProjection = useCanonicalProfilesProjection(roster?.map((member) => member.userId) ?? [])
  const profiles = profileProjection.data
  const membershipProjection = useServerMemberProjection(query.data?.serverId === null ? null : query.data?.serverId ?? serverId ?? null, roster?.map((member) => member.userId) ?? [])
  const members = useMemo<ChannelMember[]>(() => {
    const byUser = new Map((membershipProjection.data ?? []).map((member) => [member.userId, member]))
    return (roster ?? []).flatMap((participant) => {
      const member = byUser.get(participant.userId)
      if (query.data?.serverId !== null && !member?.memberId) return []
      if (!profileProjection.resourceProfiles.has(participant.userId)) return []
      const profile = readCommunityProfile(profiles.get(participant.userId), participant.userId)
      return [{ id: member?.memberId ?? participant.userId, userId: participant.userId, name: member?.nickname ?? profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion, role: member ? member.role as CommunityRole : null, sub: "", status: profile.presence, statusEmoji: profile.statusEmoji ?? null, statusText: profile.statusText ?? "", source: participant.source, isCreator: query.data?.creatorIds.includes(participant.userId) === true }]
    })
  }, [profiles, profileProjection.resourceProfiles, membershipProjection.data, roster, query.data?.serverId, query.data?.creatorIds])
  const projections = query.data?.serverId === null ? [rosterProjection, profileProjection] : [rosterProjection, membershipProjection, profileProjection]
  const complete = !!query.data && projections.every(projection => projection.isReady && projection.isEnabled && !projection.isError)
    && query.data.members.every(identity => roster?.some(row => row.userId === identity.userId))
    && (roster ?? []).every(row => profileProjection.resourceProfiles.has(row.userId)
      && (query.data?.serverId === null || membershipProjection.data?.some(member => member.userId === row.userId && member.memberId)))
  const readState = getMemberReadState(active, { pending: !complete && (!query.data || query.isRefetching), failed: !complete
    && (query.isError && !query.isFetching || !!query.data && projections.every(projection => projection.isReady)) }, projections, (roster ?? []).filter((member) => member.userId !== rosterProjection.registry?.accountId).map((member) => member.userId), profileProjection.resourceProfiles)
  const data = useMemo(() => active && complete ? { members } : undefined, [active, complete, members])
  const isCurrentRead = () => {
    const state = client.getQueryState<ChannelRosterWindow>(channelMembersOptions(client, channelId, serverId, relation).queryKey)
    return active && complete && getCommunityDbRegistry(client) === profileProjection.registry && state?.status === "success"
      && !state.isInvalidated && state.data === query.data && state.data?.observed === true
  }
  return { ...query, data, members: active ? members : [], profiles, ...readState, observed: isCurrentRead(), isCurrentRead }
}

type AddableMembersResult = Omit<UseQueryResult<AddableMembersWindow>, "data"> & { data: { members: AddableMember[] } | undefined; members: AddableMember[]; observed: boolean; isCurrentRead: () => boolean }

export function useAddableMembers(serverId: string, channelId: string, enabled = true): AddableMembersResult {
  const client = useQueryClient()
  const active = enabled && !!serverId && !!channelId
  const query = useQuery({ queryKey: communityKeys.channelAddableMembers(channelId), queryFn: (context) => addableMembersQueryFn(serverId, channelId, context), enabled: active, subscribed: active })
  const ids = useMemo(() => query.data?.members ?? [], [query.data?.members])
  const profileProjection = useCanonicalProfilesProjection(ids.map((member) => member.userId))
  const membershipProjection = useServerMemberProjection(serverId, ids.map((member) => member.userId))
  const rosterProjection = useChannelRosterProjection(channelId, query.data?.relation ?? "access")
  const profiles = profileProjection.data
  const memberships = useMemo(() => membershipProjection.data ?? [], [membershipProjection.data])
  const roster = useMemo(() => rosterProjection.data ?? [], [rosterProjection.data])
  const members = useMemo<AddableMember[]>(() => {
    const present = new Set(roster.map((member) => member.userId))
    const current = new Map(memberships.map((member) => [member.userId, member]))
    return ids.flatMap((identity) => {
      const member = current.get(identity.userId)
      if (present.has(identity.userId) || member?.memberId !== identity.id || !profileProjection.resourceProfiles.has(identity.userId)) return []
      const profile = readCommunityProfile(profiles.get(identity.userId), identity.userId)
      return [{ userId: identity.userId, name: member.nickname ?? profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion }]
    })
  }, [ids, profiles, profileProjection.resourceProfiles, memberships, roster])
  const complete = !!query.data && [profileProjection, membershipProjection, rosterProjection].every(projection => projection.isReady && projection.isEnabled && !projection.isError)
    && ids.every(identity => memberships.some(member => member.userId === identity.userId && member.memberId === identity.id) && profileProjection.resourceProfiles.has(identity.userId))
  const data = useMemo(() => active && complete ? { members } : undefined, [active, complete, members])
  const isCurrentRead = () => {
    const state = client.getQueryState<AddableMembersWindow>(communityKeys.channelAddableMembers(channelId))
    return active && complete && getCommunityDbRegistry(client) === profileProjection.registry && state?.status === "success"
      && !state.isInvalidated && state.data === query.data && state.data?.observed === true
  }
  return { ...query, data, members: active && complete ? members : [], observed: isCurrentRead(), isCurrentRead }
}

export type ChannelMemberCommandInput = { userId: string; assertActive?: (() => void) & { signal: AbortSignal } }

export function useChannelMemberCommand(channelId: string, kind: "add" | "remove", options?: { endpoint?: "members" | "participants"; relation?: "access" | "notify"; selfRemoveUserId?: string; onConfirmed?: (userId: string, assertActive: (() => void) & { signal: AbortSignal }) => void | Promise<void> }) {
  const origin = useCommunityMutationOrigin(), client = useQueryClient()
  const source = useCommunityViewSource(`channel-member-command:${channelId}`)
  type Intent = ChannelMemberCommandInput & { view: ReturnType<typeof source.capture>; original: ReturnType<typeof origin.begin>["token"]; resources: ReturnType<ReturnType<typeof client.getQueryCache>["findAll"]> }
  const isSelfRemove = useCallback((userId: string) => kind === "remove" && Boolean(options?.selfRemoveUserId && userId === options.selfRemoveUserId), [kind, options?.selfRemoveUserId])
  const native = useMutation({ meta: { observabilityAction: kind === "add" ? "channel.member.add" : "channel.member.remove" },
    mutationKey: ["community", "channel-member-command", channelId], scope: { id: "channel-member-command:" + channelId },
    mutationFn: async ({ userId, original, resources, assertActive, view }: Intent) => {
      const selfRetire = isSelfRemove(userId)
      const assert = Object.assign(() => { origin.assert(original); view(); assertActive?.() }, { signal: assertActive?.signal ?? view.signal })
      const assertPostSelf = Object.assign(() => { origin.assertOwner(original); view.assertOwner(); assertActive?.() }, { signal: assertActive?.signal ?? view.signal })
      assert()
      const proof = origin.begin().token, registry = origin.registry!
      await registry.ready
      assert()
      await registry.collections.channelMemberships.preload()
      assert()
      const relation = options?.relation ?? "access"
      const id = channelMembershipKey(channelId, userId, relation)
      const collection = registry.collections.channelMemberships
      let confirmed = false
      const persist = async () => {
        const endpoint = options?.endpoint ?? "members"
        const path = "/api/community/channels/" + encodeURIComponent(channelId) + "/" + endpoint + (kind === "remove" ? "/" + encodeURIComponent(userId) : "")
        if (selfRetire) {
          const ownerController = new AbortController()
          const subscription = registry.runtime.lifecycle.subscribe(() => {
            try { origin.assertOwner(original) } catch { ownerController.abort() }
          })
          const requestSignal = AbortSignal.any([ownerController.signal, assertPostSelf.signal])
          try {
            await apiFetch(path, { method: "DELETE", ...communityRequestOptions(client, original, requestSignal, assertPostSelf) })
            assertPostSelf()
          } finally { subscription.unsubscribe() }
          await completeCommunityPublication(client, () => setCanonicalCommunityChannelMember(client, channelId, userId, relation, false, { event: true }))
          confirmed = true
          return
        }
        await origin.request(original, path, { method: kind === "remove" ? "DELETE" : "POST", signal: assert.signal, assertActive: assert, ...(kind === "add" ? { body: JSON.stringify({ userId }) } : {}) })
        assert()
        confirmed = await completeCommunityPublication(client, () => setCanonicalCommunityChannelMember(client, channelId, userId, relation, kind === "add", { proof: { token: proof } }))
      }
      try {
        const transaction = registry.dbClient.createTransaction({ autoCommit: false, mutationFn: persist })
        const rollbackRetired = () => {
          if (transaction.state !== "completed" && transaction.state !== "failed") transaction.rollback({ error: new DOMException("Retired member command", "AbortError") })
        }
        if (!selfRetire) assert.signal.addEventListener("abort", rollbackRetired, { once: true })
        if (!selfRetire && assert.signal.aborted) rollbackRetired()
        try {
          assert()
          transaction.mutate(() => {
            if (kind === "remove") { if (collection.has(id)) collection.delete(id) }
            else if (!collection.has(id)) collection.insert({ id, channelId, userId, relation, source: "explicit" })
          })
          try {
            if (transaction.mutations.length) await transaction.commit()
            else await persist()
          } catch (error) {
            ;(selfRetire ? assertPostSelf : assert)()
            throw error
          }
          if (confirmed) {
            if (selfRetire) { assertPostSelf(); await options?.onConfirmed?.(userId, assertPostSelf) }
            else { assert(); await options?.onConfirmed?.(userId, assert) }
          }
          if (selfRetire) assertPostSelf()
          else assert()
        } finally {
          if (!selfRetire) assert.signal.removeEventListener("abort", rollbackRetired)
        }
      } finally {
        try {
          if (selfRetire) origin.assertOwner(original)
          else origin.assert(original)
          for (const resource of resources) if (client.getQueryCache().find({ queryKey: resource.queryKey, exact: true }) === resource) void client.invalidateQueries({ queryKey: resource.queryKey, exact: true }).catch(() => undefined)
        } catch {}
      }
    },
  })
  const capture = useCallback((input: string | ChannelMemberCommandInput): Intent => {
    const value = typeof input === "string" ? { userId: input } : input
    value.assertActive?.()
    const view = source.capture()
    view()
    return { ...value, view, original: origin.begin().token, resources: [communityKeys.channelMembers(channelId), communityKeys.channelAddableMembers(channelId)].flatMap((queryKey) => client.getQueryCache().findAll({ queryKey })) }
  }, [origin, client, channelId, source])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.view(); args.assertActive?.() }, [origin])
  const assertSuccess = useCallback((args: Intent) => {
    if (isSelfRemove(args.userId)) { origin.assertOwner(args.original); args.view.assertOwner(); args.assertActive?.(); return }
    assertCurrent(args)
  }, [assertCurrent, isSelfRemove, origin])
  return useNativeMutationFacade(native, capture, assertCurrent, { assertSuccess })
}
export const useAddChannelMember = (channelId: string) => useChannelMemberCommand(channelId, "add")
export function useRemoveChannelMember(channelId: string, serverId?: string, viewerUserId?: string) {
  const client = useQueryClient()
  return useChannelMemberCommand(channelId, "remove", {
    selfRemoveUserId: viewerUserId,
    onConfirmed: async (userId) => {
      if (!viewerUserId || userId !== viewerUserId) return
      const registry = getCommunityDbRegistry(client)
      if (registry) await completeCommunityPublication(client, () => retireCommunityChannelReading(registry, channelId, { reason: "read-denied", serverId: serverId ?? null }))
    },
  })
}
