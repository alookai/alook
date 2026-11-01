"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useChannelMemberCommand } from "./use-channel-members"
import { grantForumSidebarChild, removeForumSidebarProjectionExact } from "./use-forum-sidebar-threads"

export function useAddThreadParticipant(channelId: string, serverId?: string, viewerUserId?: string) {
  const client = useQueryClient()
  return useChannelMemberCommand(channelId, "add", { endpoint: "participants", relation: "notify", onConfirmed: async (userId, assertActive) => {
    if (serverId && userId === viewerUserId) await grantForumSidebarChild(client, serverId, channelId, assertActive)
  } })
}

export function useRemoveThreadParticipant(channelId: string, serverId?: string, viewerUserId?: string, forumSidebar = !!serverId) {
  const client = useQueryClient()
  return useChannelMemberCommand(channelId, "remove", { endpoint: "participants", relation: "notify", onConfirmed: (userId) => {
    if (userId !== viewerUserId) return
    if (serverId && forumSidebar) { removeForumSidebarProjectionExact(client, serverId, channelId) }
  } })
}
