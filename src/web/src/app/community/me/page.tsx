"use client"

import { useRouter } from "next/navigation"
import { useBreakpoint } from "@/hooks/use-mobile"
import { FriendsPage } from "@/components/community/friends-page"
import { useMemo } from "react"
import { useFriends } from "@/hooks/community/use-friends"
import { useUiHandlers } from "@/stores/community"
import { useOnlineUserIds } from "@/stores/community/ws"
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

export default function MeFriendsPage() {
  const router = useRouter()
  const bp = useBreakpoint()
  const { friends: rawFriends, pending, blocked, isLoading } = useFriends()
  const uiHandlers = useUiHandlers()
  const onlineUserIds = useOnlineUserIds()
  const friends = useMemo(
    () =>
      rawFriends.map((f) => ({
        ...f,
        status: onlineUserIds.has(f.userId ?? f.id)
          ? ("online" as const)
          : ("offline" as const),
      })),
    [rawFriends, onlineUserIds],
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
            onError: () => toast("Failed to accept request"),
          },
        )
      }
      onReject={(id) =>
        rejectFriendRequest.mutate(
          { friendshipId: id },
          { onError: () => toast("Failed to reject request") },
        )
      }
      onCancelRequest={(id) =>
        rejectFriendRequest.mutate({ friendshipId: id })
      }
      onUnblock={(id) =>
        unblockUser.mutate(
          { userId: id },
          {
            onSuccess: () => toast("User unblocked"),
            onError: () => toast("Failed to unblock user"),
          },
        )
      }
      onSendRequest={async (username) => {
        try {
          await sendFriendRequest.mutateAsync({ username })
          toast("Friend request sent")
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Failed to send friend request"
          toast(msg)
        }
      }}
      onRemoveFriend={(id) =>
        removeFriend.mutate(
          { friendshipId: id },
          {
            onSuccess: () => toast("Friend removed"),
            onError: () => toast("Failed to remove friend"),
          },
        )
      }
      onBlock={(id) =>
        blockUser.mutate(
          { userId: id },
          {
            onSuccess: () => toast("User blocked"),
            onError: () => toast("Failed to block user"),
          },
        )
      }
      onDm={async (userId) => {
        try {
          const data = await createOrGetDm.mutateAsync({ userId })
          if (data.conversation.id) router.push(`/community/me/${data.conversation.id}`)
        } catch {
          toast("Failed to open DM")
        }
      }}
    />
  )
}
