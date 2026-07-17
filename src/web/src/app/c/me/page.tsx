"use client"

import { useRouter } from "next/navigation"
import { useBreakpoint } from "@/hooks/use-mobile"
import { FriendsPage } from "@/components/community/friends-page"
import { useMemo } from "react"
import { useFriends } from "@/hooks/community/use-friends"
import { useUiHandlers } from "@/stores/community"
import { useOnlineUserIds, useCommunityWsStore } from "@/stores/community/ws"
import { resolveRowPresence } from "@/lib/community/presence"
import {
  useSendFriendRequest,
  useAcceptFriendRequest,
  useRejectFriendRequest,
  useRemoveFriend,
  useBlockUser,
  useUnblockUser,
  useCreateOrGetDm,
} from "@/hooks/community/mutations"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"

export default function MeFriendsPage() {
  const router = useRouter()
  const bp = useBreakpoint()
  const { friends: rawFriends, pending, blocked, isLoading } = useFriends()
  const uiHandlers = useUiHandlers()
  const onlineUserIds = useOnlineUserIds()
  const userStatuses = useCommunityWsStore((s) => s.userStatuses)
  const friends = useMemo(
    () =>
      rawFriends.map((f) => {
        const liveStatus = userStatuses.get(f.userId ?? f.id)
        return {
          ...f,
          status: resolveRowPresence(f, onlineUserIds),
          statusEmoji: liveStatus ? liveStatus.emoji : f.statusEmoji,
          statusText: liveStatus ? liveStatus.text : f.statusText,
        }
      }),
    [rawFriends, onlineUserIds, userStatuses],
  )

  const sendFriendRequest = useSendFriendRequest()
  const acceptFriendRequest = useAcceptFriendRequest()
  const rejectFriendRequest = useRejectFriendRequest()
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
      onBack={bp === "mobile" ? () => uiHandlers.goBackMobile?.() : undefined}
      onAccept={(id) =>
        acceptFriendRequest.mutate(
          { friendshipId: id },
          {
            onSuccess: () => toast("Friend request accepted"),
            onError: (e) => toastApiError(e, "Failed to accept request"),
          },
        )
      }
      onReject={(id) =>
        rejectFriendRequest.mutate(
          { friendshipId: id },
          { onError: (e) => toastApiError(e, "Failed to reject request") },
        )
      }
      onCancelRequest={(id) =>
        rejectFriendRequest.mutate(
          { friendshipId: id },
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
      onSendRequest={async (username) => {
        try {
          await sendFriendRequest.mutateAsync({ username })
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
          if (data.conversation.id) router.push(`/c/me/${data.conversation.id}`)
        } catch (e) {
          toastApiError(e, "Failed to open DM")
        }
      }}
    />
  )
}
