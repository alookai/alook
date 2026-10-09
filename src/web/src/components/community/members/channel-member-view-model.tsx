"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { useCallback, useEffect, useMemo, type ComponentProps, type ReactNode } from "react"
import { toast } from "sonner"
import { isForum, type CommunityRole as Role, type CommunityChannelIdentity } from "@alook/shared"
import type { Category, Channel } from "@/lib/community/models/navigation"
import { AddMembersDialog } from "@/components/community/members/add-members-dialog"
import type { CommunityPanel } from "@/components/community/shell/community-panel"
import type { Member } from "@/lib/community/models/people"
import type { ComposerProps } from "@/components/community/messages/composer"
import { toastApiError } from "@/lib/api/client"
import { makeUserNameResolver } from "@/lib/community/display-name"
import { readCommunityProfile } from "@/lib/community/profile-read"
import {
  useAddableMembers,
  useAddChannelMember,
  useChannelMembers,
  useRemoveChannelMember,
} from "@/hooks/community/use-channel-members"
import { useServerMembers } from "@/hooks/community/use-server-members"
import { useViewerServerRole } from "@/hooks/community/use-servers"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import {
  useAddThreadParticipant,
  useRemoveThreadParticipant,
} from "@/hooks/community/use-thread-participants"
import { useKickMember, useSetMemberRole } from "@/hooks/community/mutations"
import type { MemberOriginalView } from "./member-management-types"
import { useCanonicalProfilesByUserId } from "@/lib/community-db/projections"

type MentionCandidateSource = NonNullable<ComposerProps["mentionCandidates"]>

type PanelProps = ComponentProps<typeof CommunityPanel>

export type ChannelMemberPanelProps = Pick<
  PanelProps,
  | "members"
  | "memberScopeId"
  | "membersLoading"
  | "membersLoadingMore"
  | "membersHasMore"
  | "onLoadMoreMembers"
  | "onSearchMembers"
  | "onAddMember"
  | "manageContext"
  | "onSetRole"
  | "onKickMember"
  | "myRole"
>

type ServerModel = {
  categories?: Array<Pick<Category, "private"> & { channels: Array<Pick<Channel, "id"> & { type?: string }> }>
} | null | undefined

type ChannelModel = Partial<Pick<CommunityChannelIdentity, "creatorId">> | null

type ChannelMeta = Pick<CommunityChannelIdentity, "parentChannelId"> & Partial<Pick<CommunityChannelIdentity, "creatorId">> & { name: NonNullable<CommunityChannelIdentity["name"]> } | null

export function useChannelMemberViewModel({
  serverId,
  channelId,
  channelName,
  currentServer,
  channelInServer,
  currentChannelMeta,
  isChildChannel,
  isNotifyUnit,
  currentUser,
  accessAllowed = true,
}: {
  serverId: string
  channelId: string
  channelName: string
  currentServer: ServerModel
  channelInServer: ChannelModel
  currentChannelMeta: ChannelMeta
  isChildChannel: boolean
  isNotifyUnit: boolean
  currentUser: { id: string }
  accessAllowed?: boolean
}): {
  composerMembers: Member[]
  composerMentionCandidates?: MentionCandidateSource
  memberPanelProps: ChannelMemberPanelProps
  manageMembersDialog: ReactNode
  resolveUserName: (userId: string) => string
  myRole: Role | undefined
} {
  const membersHook = useServerMembers(accessAllowed && currentServer ? serverId : null)
  const myRole = useViewerServerRole(accessAllowed && currentServer ? serverId : null, currentUser.id)
  const source = useCommunityViewSource(`channel-members:${serverId}:${channelId}`, accessAllowed)
  const originalView = useCallback((caller?: MemberOriginalView) => {
    const local = source.capture()
    return Object.assign(() => { local(); caller?.() }, { signal: caller?.signal ?? local.signal })
  }, [source])
  const members = membersHook.members
  const [memberUi, setMemberUi] = useAtom(useCreateAtom({ channelId, query: "", dialogOpen: false }))
  const memberQuery = memberUi.channelId === channelId ? memberUi.query : ""
  const manageMembersOpen = memberUi.channelId === channelId && memberUi.dialogOpen

  useEffect(() => {
    setMemberUi((current) =>
      current.channelId === channelId && current.query === "" && !current.dialogOpen
        ? current
        : { channelId, query: "", dialogOpen: false },
    )
  }, [channelId, setMemberUi])

  const currentChannelPrivate = useMemo(() => {
    const anchorId = isChildChannel
      ? (currentChannelMeta?.parentChannelId ?? channelId)
      : channelId
    const category = currentServer?.categories?.find((candidate) =>
      candidate.channels.some((channel) => channel.id === anchorId),
    )
    return !!category?.private
  }, [channelId, currentChannelMeta, currentServer, isChildChannel])

  const channelMembersHook = useChannelMembers(
    channelId,
    accessAllowed && (isNotifyUnit || (currentChannelPrivate && !isNotifyUnit)),
    serverId,
    isNotifyUnit ? "notify" : "access",
  )
  const parentChannelId = isNotifyUnit ? currentChannelMeta?.parentChannelId ?? null : null
  const parentChannelMembersHook = useChannelMembers(
    parentChannelId ?? "",
    accessAllowed && !!parentChannelId,
    serverId,
    "access",
  )
  const participantMembersData = channelMembersHook.data
  const parentMembersData = parentChannelMembersHook.data
  const refetchParticipantMembers = channelMembersHook.refetch
  const refetchParentMembers = parentChannelMembersHook.refetch
  const participantCandidatesResolved =
    participantMembersData !== undefined && parentMembersData !== undefined
  const participantCandidatesError = !participantCandidatesResolved && (
    (participantMembersData === undefined && channelMembersHook.isError) ||
    (parentMembersData === undefined && parentChannelMembersHook.isError)
  )
  const participantCandidatesLoading =
    !participantCandidatesResolved && !participantCandidatesError
  const participantCandidatesRetrying = !participantCandidatesResolved && (
    (participantMembersData === undefined && channelMembersHook.isFetching) ||
    (parentMembersData === undefined && parentChannelMembersHook.isFetching)
  )
  const retryParticipantCandidates = useCallback(() => {
    const retries: Array<Promise<unknown>> = []
    if (participantMembersData === undefined) retries.push(refetchParticipantMembers())
    if (parentMembersData === undefined) retries.push(refetchParentMembers())
    void Promise.all(retries)
  }, [
    parentMembersData,
    participantMembersData,
    refetchParentMembers,
    refetchParticipantMembers,
  ])
  const addableChannelMembers = useAddableMembers(
    serverId,
    channelId,
    accessAllowed && manageMembersOpen && currentChannelPrivate && !isNotifyUnit,
  )
  const {
    data: addableMembersData,
    isError: addableMembersError,
    isFetching: addableMembersFetching,
    isLoading: addableMembersLoading,
    members: addableMembers,
    refetch: refetchAddableMembers,
  } = addableChannelMembers
  const addChannelMemberMut = useAddChannelMember(channelId)
  const removeChannelMemberMut = useRemoveChannelMember(channelId)
  const parentChannel = currentChannelMeta?.parentChannelId
    ? currentServer?.categories
      ?.flatMap((category) => category.channels)
      .find((channel) => channel.id === currentChannelMeta.parentChannelId)
    : null
  const forumSidebarServerId = isChildChannel && isForum(parentChannel?.type)
    ? serverId
    : undefined
  const addThreadParticipantMut = useAddThreadParticipant(
    channelId,
    forumSidebarServerId,
    currentUser.id,
  )
  const removeThreadParticipantMut = useRemoveThreadParticipant(
    channelId,
    serverId,
    currentUser.id,
    !!forumSidebarServerId,
  )
  const setMemberRoleMut = useSetMemberRole()
  const kickMemberMut = useKickMember()
  const profileIds = useMemo(() => [...new Set([...members.map((member) => member.userId), ...channelMembersHook.members.map((member) => member.userId), ...parentChannelMembersHook.members.map((member) => member.userId), ...addableMembers.map((member) => member.userId)])], [members, channelMembersHook.members, parentChannelMembersHook.members, addableMembers])
  const profilesByUserId = useCanonicalProfilesByUserId(profileIds)

  const panelMembers = useMemo(() => {
    const query = memberQuery.trim().toLowerCase()
    const matches = (name: string, discriminator?: string | null) =>
      !query || name.toLowerCase().includes(query) || (discriminator ?? "").toLowerCase().includes(query)
    const withPresence = (member: {
      userId: string
      sub: string
      isCreator?: boolean
      source?: Member["source"]
    }): Member => {
      const profile = readCommunityProfile(
        profilesByUserId.get(member.userId),
        member.userId,
      )
      return {
        id: member.userId,
        userId: member.userId,
        name: profile.name,
        discriminator: profile.discriminator,
        avatar: profile.avatar,
        avatarVersion: profile.avatarVersion,
        sub: member.sub,
        role: "member",
        status: member.userId === currentUser.id ? "online" : profile.presence,
        statusEmoji: profile.statusEmoji,
        statusText: profile.statusText,
        isCreator: member.isCreator,
        source: member.source,
      }
    }

    if (isNotifyUnit) {
      return channelMembersHook.members
        .map((member) => withPresence({ ...member, source: undefined }))
        .filter((member) => matches(member.name, member.discriminator))
    }
    if (!currentChannelPrivate) return members
    return channelMembersHook.members
      .map(withPresence)
      .filter((member) => matches(member.name, member.discriminator))
  }, [
    channelMembersHook.members,
    currentChannelPrivate,
    currentUser.id,
    isNotifyUnit,
    memberQuery,
    members,
    profilesByUserId,
  ])

  const composerMemberSource = isNotifyUnit ? parentChannelMembersHook : channelMembersHook
  const composerMembers = useMemo(() => {
    if (!accessAllowed) return []
    if (!currentChannelPrivate) {
      return members.filter((member) => member.userId !== currentUser.id)
    }
    return composerMemberSource.members
      .filter((member): member is typeof member & { role: Role } => member.role !== null)
      .filter((member) => member.userId !== currentUser.id)
      .map((member) => {
        const profile = readCommunityProfile(
          composerMemberSource.profiles.get(member.userId),
          member.userId,
        )
        return {
          ...member,
          name: profile.name,
          discriminator: profile.discriminator,
          avatar: profile.avatar,
          avatarVersion: profile.avatarVersion,
          status: profile.presence,
          statusEmoji: profile.statusEmoji,
          statusText: profile.statusText,
        }
      })
  }, [
    accessAllowed,
    composerMemberSource.members,
    composerMemberSource.profiles,
    currentChannelPrivate,
    currentUser.id,
    members,
  ])

  const composerMentionCandidates = useMemo<MentionCandidateSource | undefined>(
    () => currentChannelPrivate
      ? { loading: composerMemberSource.loading, failed: composerMemberSource.failed }
      : {
          loading: membersHook.loading,
          loadingMore: membersHook.loadingMore,
          hasMore: membersHook.hasMore,
          failed: membersHook.failed,
          searchQuery: membersHook.searchQuery,
          searchStatus: membersHook.searchStatus,
          loadMore: membersHook.loadMore,
          search: membersHook.searchMembers,
        },
    [
      currentChannelPrivate,
      composerMemberSource.loading,
      composerMemberSource.failed,
      membersHook.failed,
      membersHook.hasMore,
      membersHook.loadMore,
      membersHook.loading,
      membersHook.loadingMore,
      membersHook.searchMembers,
      membersHook.searchQuery,
      membersHook.searchStatus,
    ],
  )

  const unitCreatorId = isChildChannel
    ? currentChannelMeta?.creatorId
    : channelInServer?.creatorId
  const viewerIsUnitCreator = !!unitCreatorId && unitCreatorId === currentUser.id
  const scopedDrawer = isNotifyUnit || currentChannelPrivate
  const removeMember = isNotifyUnit ? removeThreadParticipantMut : removeChannelMemberMut
  const manageContext = scopedDrawer
    ? {
        viewerUserId: currentUser.id,
        viewerIsCreator: viewerIsUnitCreator,
        unitLabel: currentChannelMeta?.name ?? channelName,
        onLeave: (userId: string, caller?: MemberOriginalView) => removeMember.mutateAsync({ userId, assertActive: originalView(caller) }),
        onRemove: (userId: string, caller?: MemberOriginalView) => removeMember.mutateAsync({ userId, assertActive: originalView(caller) }),
      }
    : undefined

  const memberPanelProps: ChannelMemberPanelProps = {
    memberScopeId: `${serverId}:${channelId}`,
    members: panelMembers,
    membersLoading: scopedDrawer ? channelMembersHook.isLoading : membersHook.loading,
    membersLoadingMore: scopedDrawer ? false : membersHook.loadingMore,
    membersHasMore: scopedDrawer ? false : membersHook.hasMore,
    onLoadMoreMembers: scopedDrawer ? undefined : membersHook.loadMore,
    onSearchMembers: scopedDrawer
      ? (query) => setMemberUi({ channelId, query, dialogOpen: manageMembersOpen })
      : membersHook.searchMembers,
    onAddMember: scopedDrawer
      ? () => setMemberUi({ channelId, query: memberQuery, dialogOpen: true })
      : undefined,
    manageContext,
    myRole,
    onSetRole: (memberId: string, role: Role) => {
      const assert = source.capture()
      assert()
      setMemberRoleMut.mutate({ serverId, memberId, role, assertActive: assert }, {
        onSuccess: () => { try { assert() } catch { return }; toast("Role updated") },
        onError: (error) => toastApiError(error, "Failed to update role", assert),
      })
    },
    onKickMember: (memberId: string, caller?: MemberOriginalView) => {
      const assert = originalView(caller)
      assert()
      return kickMemberMut.mutateAsync({ serverId, memberId, assertActive: assert }).then(() => { assert(); toast("Member kicked") })
    },
  }

  const manageMembersDialog = useMemo(() => {
    if (!manageMembersOpen) return null
    if (isNotifyUnit) {
      const participantIds = new Set(
        participantMembersData?.members.map((member) => member.userId) ?? [],
      )
      const candidates = (participantMembersData && parentMembersData ? parentMembersData.members : [])
        .filter((member) => !participantIds.has(member.userId) && member.userId !== currentUser.id)
        .map((member) => ({ userId: member.userId, name: member.name ?? null, avatar: member.avatar }))
      return (
        <AddMembersDialog
          scopeId={`${serverId}:${channelId}:notify`}
          title={`Add participants to /${currentChannelMeta?.name ?? channelName}`}
          subtitle="Added people are notified of new replies. Anyone with access can already read it."
          candidates={candidates}
          queryState={{
            resolved: participantCandidatesResolved,
            loading: participantCandidatesLoading,
            error: participantCandidatesError,
            retrying: participantCandidatesRetrying,
            retry: retryParticipantCandidates,
          }}
          onAdd={(userId, caller) => addThreadParticipantMut.mutateAsync({ userId, assertActive: originalView(caller) })}
          onClose={() => setMemberUi({ channelId, query: memberQuery, dialogOpen: false })}
        />
      )
    }
    const candidates = addableMembers.map((member) => ({
      userId: member.userId,
      name: member.name ?? null,
      avatar: member.avatar,
    }))
    return (
      <AddMembersDialog
        scopeId={`${serverId}:${channelId}:access`}
        title={`Add members to /${channelName}`}
        subtitle="Added members can see and post here."
        candidates={candidates}
        queryState={{
          resolved: addableMembersData !== undefined,
          loading: addableMembersLoading,
          error: addableMembersError,
          retrying:
            addableMembersData === undefined && addableMembersFetching,
          retry: () => { void refetchAddableMembers() },
        }}
        onAdd={(userId, caller) => addChannelMemberMut.mutateAsync({ userId, assertActive: originalView(caller) })}
        onClose={() => setMemberUi({ channelId, query: memberQuery, dialogOpen: false })}
      />
    )
  }, [manageMembersOpen, isNotifyUnit, addableMembers, serverId, channelId, channelName, addableMembersData, addableMembersLoading, addableMembersError, addableMembersFetching, participantMembersData, parentMembersData, currentChannelMeta?.name, participantCandidatesResolved, participantCandidatesLoading, participantCandidatesError, participantCandidatesRetrying, retryParticipantCandidates, currentUser.id, addThreadParticipantMut, originalView, setMemberUi, memberQuery, refetchAddableMembers, addChannelMemberMut])

  const memberNames = JSON.stringify(membersHook.members.map(({ userId, id, name }) => ({ userId, id, name })))
  const resolveUserName = useMemo(
    () => makeUserNameResolver(JSON.parse(memberNames) as Array<{ userId: string; id: string; name: string }>),
    [memberNames],
  )

  return {
    composerMembers,
    composerMentionCandidates,
    memberPanelProps,
    manageMembersDialog,
    resolveUserName,
    myRole,
  }
}
