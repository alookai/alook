"use client"

import { useBreakpoint } from "@/hooks/use-mobile"
import { FriendsPage } from "@/components/community/social/friends-page"
import { useMemo } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useFriends } from "@/hooks/community/use-friends"
import { useUiHandlers } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { readCommunityProfile } from "@/lib/community/profile-read"
import {
  useSendFriendRequest,
  useAcceptFriendRequest,
  useRejectFriendRequest,
  useCancelBotFriendRequest,
  useRemoveFriend,
  useBlockUser,
  useUnblockUser,
  useCreateOrGetDm,
} from "@/hooks/community/mutations"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"

export default function MeFriendsPage() {
  const bp = useBreakpoint()
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeTab = searchParams.get("tab") === "new" ? "new" : "all"
  const { friends: rawFriends, pending, blocked, isLoading } = useFriends()
  const uiHandlers = useUiHandlers()
  const profilesByUserId = useCommunityWsStore((s) => s.profilesByUserId)
  const friends = useMemo(
    () =>
      rawFriends.map((f) => {
        const userId = f.userId ?? f.id
        const profile = readCommunityProfile(profilesByUserId.get(userId), userId)
        return {
          ...f,
          name: profile.name,
          discriminator: profile.discriminator,
          avatar: profile.avatar,
          avatarVersion: profile.avatarVersion,
          status: profile.presence,
          statusEmoji: profile.statusEmoji,
          statusText: profile.statusText,
        }
      }),
    [profilesByUserId, rawFriends],
  )

  const sendFriendRequest = useSendFriendRequest()
  const acceptFriendRequest = useAcceptFriendRequest()
  const rejectFriendRequest = useRejectFriendRequest()
  const cancelBotFriendRequest = useCancelBotFriendRequest()
  const removeFriend = useRemoveFriend()
  const blockUser = useBlockUser()
  const unblockUser = useUnblockUser()
  const createOrGetDm = useCreateOrGetDm()

  return (
    <FriendsPage
      friends={friends}
      pending={pending}
      blocked={blocked}
      loading={isLoading}
      activeTab={activeTab}
      onActiveTabChange={(tab) => {
        router.replace(tab === "new" ? "/c/me/friends?tab=new" : "/c/me/friends")
      }}
      onOpenProfile={(name, event, discriminator, userId) => {
        uiHandlers.openProfile?.(name, event, discriminator, userId)
      }}
      onBack={bp === "mobile" ? () => uiHandlers.goBackMobile?.() : undefined}
      onAccept={async (id) => {
        try {
          await acceptFriendRequest.mutateAsync({ friendshipId: id })
          toast("Friend request accepted")
        } catch (error) {
          toastApiError(error, "Failed to accept request")
          throw error
        }
      }}
      onReject={async (id) => {
        try {
          await rejectFriendRequest.mutateAsync({ friendshipId: id })
        } catch (error) {
          toastApiError(error, "Failed to reject request")
          throw error
        }
      }}
      onCancelRequest={({ id }) =>
        // Unified after migration 0065 — outgoing pendings (own or the owner's
        // bots') are real community_friendship rows cancelled via DELETE.
        cancelBotFriendRequest.mutate(
          { requestId: id },
          { onError: (e) => toastApiError(e, "Failed to cancel request") },
        )
      }
      onUnblock={(id) =>
        unblockUser.mutate(
          { userId: id },
          {
            onSuccess: () => toast("User unblocked"),
            onError: (e) => toastApiError(e, "Failed to unblock user"),
          },
        )
      }
      onSendRequest={async ({ userId, username }) => {
        try {
          await sendFriendRequest.mutateAsync({ userId, username })
          toast("Friend request sent")
        } catch (e) {
          toastApiError(e, "Failed to send friend request")
        }
      }}
      onRemoveFriend={(id) =>
        removeFriend.mutate(
          { friendshipId: id },
          {
            onSuccess: () => toast("Friend removed"),
            onError: (e) => toastApiError(e, "Failed to remove friend"),
          },
        )
      }
      onBlock={(id) =>
        blockUser.mutate(
          { userId: id },
          {
            onSuccess: () => toast("User blocked"),
            onError: (e) => toastApiError(e, "Failed to block user"),
          },
        )
      }
      onDm={async (userId) => {
        try {
          const data = await createOrGetDm.mutateAsync({ userId })
          if (data.conversation.id) uiHandlers.navigatePath?.(`/c/me/${data.conversation.id}`)
        } catch (e) {
          toastApiError(e, "Failed to open DM")
        }
      }}
    />
  )
}
