"use client"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback,useMemo } from "react"
import { QueryObserver,useMutation,useQuery,useQueryClient,type QueryClient,type QueryFunctionContext,type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { COMMUNITY_CONTRACT_VERSION, CommunityMembersReadSchema, CommunityResourceProfileSchema, type CommunityMembersRead, type CommunityRole, type CommunityChannelResource, type CommunityMemberRelation, type CommunityResourceProfile } from "@alook/shared"
import type { CommunityProfile, CommunityUserCore, Presence } from "@/lib/community/models/people"
import { fetchAllServerMembers } from "./fetch-all-server-members"

import { getMemberReadState, useCanonicalProfilesByUserId, useCanonicalProfilesProjection, useServerMemberRows, useServerMemberProjection, useChannelRosterRows, useChannelRosterProjection } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken,assertCommunityLiveSnapshotTokenCurrent,publishCommunityChannelMembersSnapshot,setCanonicalCommunityChannelMember } from "@/lib/community-db/sync"
import { channelMembershipKey, type ChannelMembershipRow } from "@/lib/community-db/schema"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { useCommunityMutationOrigin } from "./community-origin"
import { useCommunityViewSource } from "./use-community-view-source"

export type ChannelMember = CommunityUserCore & Pick<CommunityMemberRelation, "userId" | "isCreator"> & Pick<CommunityResourceProfile, "statusEmoji" | "statusText"> & {
  id: string
  sub: string
  role: CommunityRole | null
  status: Presence
  source: NonNullable<ChannelMembershipRow["source"]>
}

function normalizeChannelRoster(channelId: string, relation: CommunityMemberRelation["relation"], response: { members: ChannelMember[] } | CommunityMembersRead): CommunityMembersRead {
  if ("contractVersion" in response) return response
  return CommunityMembersReadSchema.parse({ contractVersion: COMMUNITY_CONTRACT_VERSION, channelId, relation,
    members: response.members.map((member) => ({ channelId, userId: member.userId, relation, memberId: member.id, source: member.source, isCreator: member.isCreator, role: member.role })),
    profiles: response.members.map((member) => CommunityResourceProfileSchema.strip().parse({ ...member, id: member.userId, statusEmoji: member.statusEmoji ?? null, statusText: member.statusText ?? "" })),
  })
}
export type AddableMember = Pick<ChannelMember, "userId" | "avatar" | "avatarVersion"> & { [Field in "name" | "discriminator"]: ChannelMember[Field] | null }
type ChannelRosterWindow = {
  serverId: CommunityChannelResource["serverId"]
  relation: CommunityMemberRelation["relation"]
  members: Array<Pick<CommunityMemberRelation, "userId"> & { id: NonNullable<CommunityMemberRelation["memberId"]> }>
}

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
      assert()
      const channel = registry.collections.channels.get(channelId)
      const scopeId = serverId ?? channel?.serverId ?? (channel?.type === "dm" ? null : undefined)
      if (scopeId === undefined) throw new DOMException("Missing channel roster scope", "AbortError")
      const dimension = relation ?? "access"
      const response = await apiFetch<{ members: ChannelMember[] } | CommunityMembersRead>("/api/community/channels/" + encodeURIComponent(channelId) + "/members?relation=" + dimension, communityRequestOptions(client, token, signal, assert))
      assert()
      const resources = normalizeChannelRoster(channelId, dimension, response)
      publishCommunityChannelMembersSnapshot(client, scopeId, channelId, dimension, resources.members, { token, signal }, resources.profiles)
      assert()
      return { serverId: scopeId, relation: dimension, members: resources.members.map(({ memberId, userId }) => ({ id: memberId ?? userId, userId })) }
    },
  }
}

async function readChannelRoster(client: QueryClient, channelId: string, serverId: string, signal: AbortSignal) {
  const original = captureCommunityLiveSnapshotToken(client, channelId)
  const assert = () => assertCommunityLiveSnapshotTokenCurrent(client, original, signal)
  assert()
  const options = channelMembersOptions(client, channelId, serverId)
  const observer = new QueryObserver(client, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(() => undefined)
  signal.addEventListener("abort", unsubscribe, { once: true })
  try {
    const window = await client.query({ ...options, select: undefined })
    assert()
    return window
  } finally { signal.removeEventListener("abort", unsubscribe); unsubscribe() }
}

async function addableMembersQueryFn(serverId: string, channelId: string, context: QueryFunctionContext) {
  const original = captureCommunityLiveSnapshotToken(context.client, channelId)
  assertCommunityLiveSnapshotTokenCurrent(context.client, original, context.signal)
  const [serverMembers, roster] = await Promise.all([
    fetchAllServerMembers(context.client, serverId, context.signal),
    readChannelRoster(context.client, channelId, serverId, context.signal),
  ])
  assertCommunityLiveSnapshotTokenCurrent(context.client, original, context.signal)
  return { serverId, relation: roster.relation, members: serverMembers.map(({ id, userId }) => ({ id, userId })) }
}

export function useChannelMembers(channelId: string, enabled = true, serverId?: string, relation?: "access" | "notify"): UseQueryResult<{ members: ChannelMember[] }> & { members: ChannelMember[]; profiles: ReadonlyMap<string, CommunityProfile>; loading: boolean; failed: boolean } {
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
      const profile = readCommunityProfile(profiles.get(participant.userId), participant.userId)
      return [{ id: member?.memberId ?? participant.userId, userId: participant.userId, name: member?.nickname ?? profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion, role: member ? member.role as CommunityRole : null, sub: "", status: member?.viewer ? "online" : profile.presence, statusEmoji: profile.statusEmoji ?? null, statusText: profile.statusText ?? "", source: participant.source ?? "explicit", isCreator: participant.isCreator ?? false }]
    })
  }, [profiles, membershipProjection.data, roster, query.data?.serverId])
  const readState = getMemberReadState(active, { pending: !query.data || query.isRefetching, failed: query.isError && !query.isFetching }, query.data?.serverId === null ? [rosterProjection, profileProjection] : [rosterProjection, membershipProjection, profileProjection], members.filter((member) => member.userId !== rosterProjection.registry?.accountId).map((member) => member.userId), profiles)
  const data = useMemo(() => active && query.data ? { members } : undefined, [active, query.data, members])
  return { ...query, data, members, profiles, ...readState } as UseQueryResult<{ members: ChannelMember[] }> & { members: ChannelMember[]; profiles: typeof profiles; loading: boolean; failed: boolean }
}

export function useAddableMembers(serverId: string, channelId: string, enabled = true): UseQueryResult<{ members: AddableMember[] }> & { members: AddableMember[] } {
  const active = enabled && !!serverId && !!channelId
  const query = useQuery({ queryKey: communityKeys.channelAddableMembers(channelId), queryFn: (context) => addableMembersQueryFn(serverId, channelId, context), enabled: active, subscribed: active })
  const ids = useMemo(() => query.data?.members ?? [], [query.data?.members])
  const profiles = useCanonicalProfilesByUserId(ids.map((member) => member.userId))
  const memberships = useServerMemberRows(serverId, ids.map((member) => member.userId))
  const roster = useChannelRosterRows(channelId, query.data?.relation ?? "access")
  const members = useMemo<AddableMember[]>(() => {
    const present = new Set(roster.map((member) => member.userId))
    const current = new Map(memberships.map((member) => [member.userId, member]))
    return ids.flatMap((identity) => {
      const member = current.get(identity.userId)
      if (present.has(identity.userId) || member?.memberId !== identity.id) return []
      const profile = readCommunityProfile(profiles.get(identity.userId), identity.userId)
      return [{ userId: identity.userId, name: member.nickname ?? profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion }]
    })
  }, [ids, profiles, memberships, roster])
  const data = useMemo(() => query.data ? { members } : undefined, [query.data, members])
  return { ...query, data, members } as UseQueryResult<{ members: AddableMember[] }> & { members: AddableMember[] }
}

export type ChannelMemberCommandInput = { userId: string; assertActive?: (() => void) & { signal: AbortSignal } }

export function useChannelMemberCommand(channelId: string, kind: "add" | "remove", options?: { endpoint?: "members" | "participants"; relation?: "access" | "notify"; onConfirmed?: (userId: string, assertActive: (() => void) & { signal: AbortSignal }) => void | Promise<void> }) {
  const origin = useCommunityMutationOrigin(), client = useQueryClient()
  const source = useCommunityViewSource(`channel-member-command:${channelId}`)
  type Intent = ChannelMemberCommandInput & { view: ReturnType<typeof source.capture>; original: ReturnType<typeof origin.begin>["token"]; resources: ReturnType<ReturnType<typeof client.getQueryCache>["findAll"]> }
  const native = useMutation({ meta: { observabilityAction: kind === "add" ? "channel.member.add" : "channel.member.remove" },
    mutationKey: ["community", "channel-member-command", channelId], scope: { id: "channel-member-command:" + channelId },
    mutationFn: async ({ userId, original, resources, assertActive, view }: Intent) => {
      const assert = Object.assign(() => { origin.assert(original); view(); assertActive?.() }, { signal: assertActive?.signal ?? view.signal })
      assert()
      const proof = origin.begin().token, registry = origin.registry!
      await registry.ready
      assert()
      await registry.collections.channelMemberships.preload()
      assert()
      const relation = options?.relation ?? "access"
      const id = channelMembershipKey(channelId, userId, relation)
      const collection = registry.collections.channelMemberships
      const persist = async () => {
        const endpoint = options?.endpoint ?? "members"
        await origin.request(original, "/api/community/channels/" + encodeURIComponent(channelId) + "/" + endpoint + (kind === "remove" ? "/" + encodeURIComponent(userId) : ""), { method: kind === "remove" ? "DELETE" : "POST", signal: assert.signal, assertActive: assert, ...(kind === "add" ? { body: JSON.stringify({ userId }) } : {}) })
        assert()
        const confirmed = setCanonicalCommunityChannelMember(client, channelId, userId, relation, kind === "add", { proof: { token: proof } })
        if (confirmed) { assert(); await options?.onConfirmed?.(userId, assert); assert() }
      }
      try {
        const transaction = registry.dbClient.createTransaction({ autoCommit: false, mutationFn: persist })
        transaction.mutate(() => {
          if (kind === "remove") { if (collection.has(id)) collection.delete(id) }
          else if (!collection.has(id)) collection.insert({ id, channelId, userId, relation, source: "explicit" })
        })
        if (transaction.mutations.length) await transaction.commit()
        else await persist()
        assert()
      } finally {
        try {
          origin.assert(original)
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
  return useNativeMutationFacade(native, capture, assertCurrent)
}
export const useAddChannelMember = (channelId: string) => useChannelMemberCommand(channelId, "add")
export const useRemoveChannelMember = (channelId: string) => useChannelMemberCommand(channelId, "remove")
