"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import { toastApiError } from "@/lib/api/client"
import { canManageServer, type CommunityRole as Role } from "@alook/shared"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { RightPanel } from "@/components/community/shell/panel-types"
import { ChannelHeader, type ChannelNotifLevel } from "@/components/community/channels/channel-header"
import { ChannelShell } from "@/components/community/channels/channel-shell"
import type { ChannelMemberPanelProps } from "@/components/community/members/channel-member-view-model"
import { CommunityPanel } from "@/components/community/shell/community-panel"
import type { NewForumThread } from "@/components/community/messages/create-forum-thread"
import { ForumSurface } from "@/components/community/channels/forum-surface"
import type { Member } from "@/lib/community/models/people"
import {
  useCreateForumThread,
  useDeleteForumThread,
  useUpdatePostTags,
} from "@/hooks/community/mutations"
import { useChannelReadStateSnapshot } from "@/hooks/community/use-channel-read-state"
import { useEagerChannelRead } from "@/hooks/community/use-eager-channel-read"

export function ForumChannelSurface({
  serverId,
  channelId,
  channelName,
  viewer,
  viewerRole,
  headerServer,
  notificationLevel,
  onSetNotificationLevel,
  onBack,
  composerMembers,
  onSearchComposerMembers,
  memberPanelProps,
  manageMembersDialog,
  onOpenPost,
  onOpenProfile,
}: {
  serverId: string
  channelId: string
  channelName: string
  viewer: { id: string }
  viewerRole: Role | undefined
  headerServer?: { id: string; name: string; icon: string | null }
  notificationLevel: ChannelNotifLevel
  onSetNotificationLevel: (level: ChannelNotifLevel) => void
  onBack?: () => void
  composerMembers: Member[]
  onSearchComposerMembers?: (query: string) => void
  memberPanelProps: ChannelMemberPanelProps
  manageMembersDialog: ReactNode
  onOpenPost: (postId: string) => void
  onOpenProfile: OpenProfile
}) {
  const readState = useChannelReadStateSnapshot(channelId)
  useEagerChannelRead({
    channelId,
    serverId,
    isChildChannel: false,
    snapshotReady: !readState.isFetching,
  })
  const [panelState, setPanelState] = useState<{ channelId: string; panel: RightPanel }>({
    channelId,
    panel: null,
  })
  const rightPanel = panelState.channelId === channelId ? panelState.panel : null
  const createForumThreadMut = useCreateForumThread()
  const updatePostTagsMut = useUpdatePostTags()
  const deleteForumThreadMut = useDeleteForumThread()

  useEffect(() => {
    setPanelState((current) =>
      current.channelId === channelId && current.panel === null
        ? current
        : { channelId, panel: null },
    )
  }, [channelId])

  const togglePanel = useCallback((panel: Exclude<RightPanel, null>) => {
    setPanelState((current) => ({
      channelId,
      panel: current.channelId === channelId && current.panel === panel ? null : panel,
    }))
  }, [channelId])
  const createForumThread = useCallback(async (post: NewForumThread) => {
    const data = await createForumThreadMut.mutateAsync({
      nonce: post.nonce,
      channelId,
      name: post.name,
      content: post.content,
      attachments: post.attachments,
      mentionType: post.mentionType,
    })
    onOpenPost(data.threadId)
  }, [channelId, createForumThreadMut, onOpenPost])
  const canManage = canManageServer(viewerRole)

  return (
    <ChannelShell
      header={(
        <ChannelHeader
          channel={channelName}
          forum
          rightPanel={rightPanel}
          onToggle={togglePanel}
          notifLevel={notificationLevel}
          onSetNotifLevel={onSetNotificationLevel}
          onBack={onBack}
          server={headerServer}
          tools={{ threads: false, pinned: false }}
        />
      )}
      body={(
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ForumSurface
            serverId={serverId}
            forumChannelId={channelId}
            members={composerMembers}
            onSearchMembers={onSearchComposerMembers}
            onOpenPost={onOpenPost}
            onCreatePost={createForumThread}
            canEditPostTags={(post) => canManage || post.authorId === viewer.id}
            savingTagsFor={updatePostTagsMut.isPending ? updatePostTagsMut.variables?.threadId ?? null : null}
            onEditPostTags={(post, tags) => {
              updatePostTagsMut.mutate(
                { forumChannelId: channelId, threadId: post.id, openerMessageId: post.openerMessageId, tags },
                { onError: (error) => toastApiError(error, "Failed to update tags") },
              )
            }}
            canDeletePost={(post) => canManage || post.authorId === viewer.id}
            deletingPost={deleteForumThreadMut.isPending ? deleteForumThreadMut.variables?.threadId ?? null : null}
            onDeletePost={(post) => {
              deleteForumThreadMut.mutate(
                { serverId, forumChannelId: channelId, threadId: post.id },
                { onError: (error) => toastApiError(error, "Failed to delete post") },
              )
            }}
          />
        </main>
      )}
      panels={rightPanel && (
        <CommunityPanel
          open
          onOpenChange={(open) => { if (!open) setPanelState({ channelId, panel: null }) }}
          kind={rightPanel}
          viewerUserId={viewer.id}
          {...memberPanelProps}
          pinned={[]}
          searchResults={[]}
          threads={[]}
          onOpenThread={onOpenPost}
          onOpenProfile={onOpenProfile}
        />
      )}
      dialogs={manageMembersDialog}
    />
  )
}
