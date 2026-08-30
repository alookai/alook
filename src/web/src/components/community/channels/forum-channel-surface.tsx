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
import type { ComposerProps } from "@/components/community/messages/composer"
import { ForumSurface } from "@/components/community/channels/forum-surface"
import type { Member } from "@/lib/community/models/people"
import {
  useCreateForumThread,
  useDeleteForumThread,
  useUpdatePostTags,
} from "@/hooks/community/mutations"

export function ForumChannelSurface({
  serverId,
  channelId,
  channelName,
  viewer,
  viewerRole,
  headerServer,
  notificationLevel,
  onSetNotificationLevel,
  composerMembers,
  composerMentionCandidates,
  memberPanelProps,
  manageMembersDialog,
  onOpenPost,
  onOpenProfile,
  embedded = false,
}: {
  serverId: string
  channelId: string
  channelName: string
  viewer: { id: string }
  viewerRole: Role | undefined
  headerServer?: { id: string; name: string; icon: string | null; onNavigate: () => void }
  notificationLevel: ChannelNotifLevel
  onSetNotificationLevel: (level: ChannelNotifLevel) => void
  composerMembers: Member[]
  composerMentionCandidates?: ComposerProps["mentionCandidates"]
  memberPanelProps: ChannelMemberPanelProps
  manageMembersDialog: ReactNode
  onOpenPost: (postId: string) => void
  onOpenProfile: OpenProfile
  embedded?: boolean
}) {
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
  const Body = embedded ? "div" : "main"

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
          mobileServer={headerServer}
          tools={{ threads: false, pinned: false }}
        />
      )}
      body={(
        <Body className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ForumSurface
            serverId={serverId}
            forumChannelId={channelId}
            members={composerMembers}
            mentionCandidates={composerMentionCandidates}
            onOpenPost={onOpenPost}
            onCreatePost={createForumThread}
            canEditPostTags={(post) => canManage || post.authorId === viewer.id}
            savingTagsFor={updatePostTagsMut.isPending ? updatePostTagsMut.variables?.threadId ?? null : null}
            onEditPostTags={async (post, tags) => {
              await updatePostTagsMut.mutateAsync(
                {
                  serverId,
                  forumChannelId: channelId,
                  threadId: post.id,
                  openerMessageId: post.openerMessageId,
                  previousTags: post.tags ?? [],
                  tags,
                },
                { onError: (error) => toastApiError(error, "Failed to update tags") },
              )
            }}
            canDeletePost={(post) => canManage || post.authorId === viewer.id}
            deletingPost={deleteForumThreadMut.isPending ? deleteForumThreadMut.variables?.threadId ?? null : null}
            onDeletePost={(post) => {
              deleteForumThreadMut.mutate(
                {
                  serverId,
                  forumChannelId: channelId,
                  threadId: post.id,
                  openerMessageId: post.openerMessageId,
                },
                { onError: (error) => toastApiError(error, "Failed to delete post") },
              )
            }}
          />
        </Body>
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
