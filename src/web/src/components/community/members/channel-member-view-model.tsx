"use client"

import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react"
import { toast } from "sonner"
import { isForum, type CommunityRole as Role } from "@alook/shared"
import { AddMembersDialog } from "@/components/community/members/add-members-dialog"
import type { CommunityPanel } from "@/components/community/shell/community-panel"
import type { Member } from "@/lib/community/models/people"
import { toastApiError } from "@/lib/api/client"
import { makeUserNameResolver } from "@/lib/community/display-name"
import { resolveRowPresence } from "@/lib/community/presence"
import {
  useAddableMembers,
  useAddChannelMember,
  useChannelMembers,
  useRemoveChannelMember,
} from "@/hooks/community/use-channel-members"
import { useServerMembers } from "@/hooks/community/use-server-members"
import {
  useAddThreadParticipant,
  useRemoveThreadParticipant,
} from "@/hooks/community/use-thread-participants"
import { useKickMember, useSetMemberRole } from "@/hooks/community/mutations"
import { useCommunityWsStore, useOnlineUserIds } from "@/stores/community/ws"

type PanelProps = ComponentProps<typeof CommunityPanel>

export type ChannelMemberPanelProps = Pick<
  PanelProps,
  | "members"
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
  categories?: Array<{
    private?: number | boolean
    channels: Array<{ id: string; type?: string }>
  }>
} | null | undefined

type ChannelModel = {
  creatorId?: string | null
} | null

type ChannelMeta = {
  name: string
  parentChannelId: string | null
  creatorId?: string | null
} | null

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
}): {
  composerMembers: Member[]
  onSearchComposerMembers: (query: string) => void
  memberPanelProps: ChannelMemberPanelProps
  manageMembersDialog: ReactNode
  resolveUserName: (userId: string) => string
  myRole: Role | undefined
} {
  const membersHook = useServerMembers(serverId)
  const onlineUserIds = useOnlineUserIds()
  const userStatuses = useCommunityWsStore((state) => state.userStatuses)
  const [memberUi, setMemberUi] = useState({ channelId, query: "", dialogOpen: false })
  const memberQuery = memberUi.channelId === channelId ? memberUi.query : ""
  const manageMembersOpen = memberUi.channelId === channelId && memberUi.dialogOpen

  useEffect(() => {
    setMemberUi((current) =>
      current.channelId === channelId && current.query === "" && !current.dialogOpen
        ? current
        : { channelId, query: "", dialogOpen: false },
    )
  }, [channelId])

  const members = useMemo(
    () => membersHook.members.map((member) => {
      const liveStatus = userStatuses.get(member.userId)
      return {
        ...member,
        status: resolveRowPresence(member, onlineUserIds, currentUser.id),
        statusEmoji: liveStatus ? liveStatus.emoji : member.statusEmoji,
        statusText: liveStatus ? liveStatus.text : member.statusText,
      }
    }),
    [currentUser.id, membersHook.members, onlineUserIds, userStatuses],
  )

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
    isNotifyUnit || (currentChannelPrivate && !isNotifyUnit),
  )
  const parentChannelId = isNotifyUnit ? currentChannelMeta?.parentChannelId ?? null : null
  const parentChannelMembersHook = useChannelMembers(parentChannelId ?? "", !!parentChannelId)
  const addableChannelMembers = useAddableMembers(
    serverId,
    channelId,
    manageMembersOpen && currentChannelPrivate && !isNotifyUnit,
  )
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

  const panelMembers = useMemo(() => {
    const query = memberQuery.trim().toLowerCase()
    const matches = (name: string, discriminator?: string | null) =>
      !query || name.toLowerCase().includes(query) || (discriminator ?? "").toLowerCase().includes(query)
    const withPresence = (member: {
      userId: string
      name: string
      discriminator: string
      avatar: string
      statusEmoji?: string | null
      statusText?: string | null
      isCreator?: boolean
      source?: "explicit" | "inherited" | "admin"
    }): Member => {
      const liveStatus = userStatuses.get(member.userId)
      return {
        id: member.userId,
        userId: member.userId,
        name: member.name,
        discriminator: member.discriminator,
        avatar: member.avatar,
        sub: "",
        role: "member",
        status: resolveRowPresence(member, onlineUserIds, currentUser.id),
        statusEmoji: liveStatus ? liveStatus.emoji : (member.statusEmoji ?? null),
        statusText: liveStatus ? liveStatus.text : (member.statusText ?? ""),
        isCreator: member.isCreator,
        source: member.source,
      }
    }

    if (isNotifyUnit) {
      return channelMembersHook.members
        .filter((member) => matches(member.name, member.discriminator))
        .map((member) => withPresence({ ...member, source: undefined }))
    }
    if (!currentChannelPrivate) return members
    return channelMembersHook.members
      .filter((member) => matches(member.name, member.discriminator))
      .map(withPresence)
  }, [
    channelMembersHook.members,
    currentChannelPrivate,
    currentUser.id,
    isNotifyUnit,
    memberQuery,
    members,
    onlineUserIds,
    userStatuses,
  ])

  const composerMembers = useMemo(() => {
    if (!currentChannelPrivate) {
      return members.filter((member) => member.userId !== currentUser.id)
    }
    const roster = isNotifyUnit ? parentChannelMembersHook.members : channelMembersHook.members
    return roster
      .filter((member) => member.userId !== currentUser.id)
      .map((member) => {
        const liveStatus = userStatuses.get(member.userId)
        return {
          ...member,
          status: resolveRowPresence(member, onlineUserIds, currentUser.id),
          statusEmoji: liveStatus ? liveStatus.emoji : member.statusEmoji,
          statusText: liveStatus ? liveStatus.text : member.statusText,
        }
      })
  }, [
    channelMembersHook.members,
    currentChannelPrivate,
    currentUser.id,
    isNotifyUnit,
    members,
    onlineUserIds,
    parentChannelMembersHook.members,
    userStatuses,
  ])

  const myRole = members.find((member) => member.userId === currentUser.id)?.role
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
        onLeave: (userId: string) => removeMember.mutateAsync(userId),
        onRemove: (userId: string) => removeMember.mutateAsync(userId),
      }
    : undefined

  const memberPanelProps: ChannelMemberPanelProps = {
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
      setMemberRoleMut.mutate({ serverId, memberId, role }, {
        onSuccess: () => toast("Role updated"),
        onError: (error) => toastApiError(error, "Failed to update role"),
      })
    },
    onKickMember: (memberId: string) =>
      kickMemberMut.mutateAsync({ serverId, memberId }).then(() => toast("Member kicked")),
  }

  const manageMembersDialog = useMemo(() => {
    if (!manageMembersOpen) return null
    if (isNotifyUnit) {
      const participantIds = new Set(channelMembersHook.members.map((member) => member.userId))
      const candidates = parentChannelMembersHook.members
        .filter((member) => !participantIds.has(member.userId) && member.userId !== currentUser.id)
        .map((member) => ({ userId: member.userId, name: member.name ?? null, avatar: member.avatar }))
      return (
        <AddMembersDialog
          title={`Add participants to /${currentChannelMeta?.name ?? channelName}`}
          subtitle="Added people are notified of new replies. Anyone with access can already read it."
          candidates={candidates}
          onAdd={(userId) => addThreadParticipantMut.mutateAsync(userId)}
          onClose={() => setMemberUi({ channelId, query: memberQuery, dialogOpen: false })}
        />
      )
    }
    const candidates = addableChannelMembers.members.map((member) => ({
      userId: member.userId,
      name: member.name ?? null,
      avatar: member.avatar,
    }))
    return (
      <AddMembersDialog
        title={`Add members to /${channelName}`}
        subtitle="Added members can see and post here."
        candidates={candidates}
        onAdd={(userId) => addChannelMemberMut.mutateAsync(userId)}
        onClose={() => setMemberUi({ channelId, query: memberQuery, dialogOpen: false })}
      />
    )
  }, [
    addChannelMemberMut,
    addThreadParticipantMut,
    addableChannelMembers.members,
    channelMembersHook.members,
    channelName,
    channelId,
    currentChannelMeta,
    currentUser.id,
    isNotifyUnit,
    manageMembersOpen,
    memberQuery,
    parentChannelMembersHook.members,
  ])

  const resolveUserName = useMemo(
    () => makeUserNameResolver(membersHook.members),
    [membersHook.members],
  )

  return {
    composerMembers,
    onSearchComposerMembers: membersHook.searchMembers,
    memberPanelProps,
    manageMembersDialog,
    resolveUserName,
    myRole,
  }
}
