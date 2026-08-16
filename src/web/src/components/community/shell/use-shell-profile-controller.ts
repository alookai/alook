"use client"

import { useCallback, useState, type ComponentProps } from "react"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { userProfileQueryFn, PROFILE_STALE_TIME_MS } from "@/hooks/community/use-user-profile"
import { validateIconSourceFile } from "@/lib/community/image-crop"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import type { Profile } from "@/components/community/social/profile-types"
import {
  resolveProfileContextLabel,
  resolveProfileServerId,
  resolveProfileTarget,
  resolveProfileUserId,
  buildSelfProfile,
} from "@/components/community/social/profile-lookup"
import { resolveProfilePresence } from "@/lib/community/presence"
import { avatarInitial } from "@/lib/community/avatar"
import { signOut } from "@/lib/auth-client"
import { clearPersistedCache } from "@/lib/query-persister"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore, useOnlineUserIds } from "@/stores/community/ws"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { useCurrentUser, useSetCurrentUser } from "@/contexts/community/current-user"
import { useFriends } from "@/hooks/community/use-friends"
import { useServerMembers } from "@/hooks/community/use-server-members"
import {
  useCreateOrGetDm,
  useUpdateProfile,
  useUploadUserAvatar,
} from "@/hooks/community/mutations"
import { useDmMessageSender } from "@/hooks/community/use-dm-message-sender"
import type { UserSettings } from "@/components/community/settings/user-settings"
import type { ImageCropDialog } from "@/components/community/image-crop-dialog"
import type { QueryClient } from "@tanstack/react-query"
import type { ShellFrameProps, ShellRouter } from "./shell-frame-types"

export type ShellProfileState = {
  data: Profile
  x: number
  y: number
  initialStatusEmoji: string | null
  initialStatusText: string | null
}

type Options = Pick<ShellFrameProps, "view" | "activeServerId"> & {
  router: ShellRouter
  queryClient: QueryClient
  cancelPendingNavigation: () => void
}

export function useShellProfileController({
  router,
  queryClient,
  cancelPendingNavigation,
  view,
  activeServerId,
}: Options) {
  const currentUser = useCurrentUser()
  const setCurrentUser = useSetCurrentUser()
  const onlineUserIds = useOnlineUserIds()
  const { friends } = useFriends()
  const profileServerId = resolveProfileServerId(view, activeServerId)
  const { members } = useServerMembers(profileServerId)
  const createOrGetDm = useCreateOrGetDm()
  const { accept: acceptDmMessage } = useDmMessageSender()
  const updateProfile = useUpdateProfile()
  const uploadUserAvatar = useUploadUserAvatar()

  const [editingProfile, setEditingProfile] = useState(false)
  const [profile, setProfile] = useState<ShellProfileState | null>(null)
  const [preview, setPreview] = useState<ImagePreview | null>(null)
  const [attachmentPreview, setAttachmentPreview] = useState<FileAttachment | null>(null)
  const [pendingAvatarCrop, setPendingAvatarCrop] = useState<{
    src: string
    fileName: string
  } | null>(null)

  const openProfile = useCallback((
    name: string,
    event: React.MouseEvent,
    discriminator?: string,
    targetUserId?: string,
  ) => {
    const isSelf = !!targetUserId && targetUserId === currentUser.id
    if (isSelf) {
      const selfMember = profileServerId
        ? members.find((member) => member.userId === currentUser.id)
        : undefined
      setProfile({
        data: buildSelfProfile(
          currentUser,
          onlineUserIds,
          resolveProfileContextLabel(profileServerId, selfMember),
        ),
        x: event.clientX,
        y: event.clientY,
        initialStatusEmoji: currentUser.statusEmoji ?? null,
        initialStatusText: currentUser.statusText ?? null,
      })
      return
    }

    const member = resolveProfileTarget(members, friends, {
      name,
      discriminator,
      userId: targetUserId,
    })
    const about = member?.sub ?? ""
    const userId = resolveProfileUserId(member, targetUserId)
    setProfile({
      data: {
        name,
        userId,
        avatar: member?.avatar ?? avatarInitial(name),
        contextLabel: resolveProfileContextLabel(profileServerId, member),
        about,
        mutual: 0,
        presence: resolveProfilePresence(false, userId, onlineUserIds),
      },
      x: event.clientX,
      y: event.clientY,
      initialStatusEmoji: member?.statusEmoji ?? null,
      initialStatusText: member?.statusText ?? null,
    })
    if (userId) {
      queryClient
        .fetchQuery({
          queryKey: communityKeys.profile(userId),
          queryFn: userProfileQueryFn(userId),
          staleTime: PROFILE_STALE_TIME_MS,
        })
        .then((profileResponse) => {
          setProfile((previous) =>
            previous
              ? {
                ...previous,
                data: {
                  ...previous.data,
                  about: profileResponse.aboutMe ?? previous.data.about,
                  mutual: profileResponse.mutualServers ?? 0,
                  discriminator: profileResponse.discriminator ?? previous.data.discriminator,
                },
                initialStatusEmoji: profileResponse.statusEmoji,
                initialStatusText: profileResponse.statusText,
              }
              : previous,
          )
        })
        .catch((error) => toastApiError(error, "Failed to load profile"))
    }
  }, [currentUser, friends, members, onlineUserIds, profileServerId, queryClient])

  const previewImage = useCallback((image: ImagePreview) => setPreview(image), [])
  const previewAttachment = useCallback(
    (attachment: FileAttachment) => setAttachmentPreview(attachment),
    [],
  )

  const updateOwnStatus = async (statusEmoji: string | null, statusText: string | null) => {
    try {
      await updateProfile.mutateAsync({ statusEmoji, statusText })
      setCurrentUser((user) => ({ ...user, statusEmoji, statusText }))
      useCommunityWsStore.getState().setUserStatus(
        currentUser.id,
        statusEmoji,
        statusText,
      )
    } catch (error) {
      toastApiError(error, "Failed to update status")
    }
  }

  const profileMessage = async (userId: string, text: string) => {
    if (!userId) {
      toast("Could not find user")
      return
    }
    let dmId: string
    try {
      const data = await createOrGetDm.mutateAsync({ userId })
      dmId = data.conversation.id
    } catch (error) {
      toastApiError(error, "Failed to open DM")
      return
    }
    const trimmed = text.trim()
    if (trimmed) {
      const receipt = acceptDmMessage({
        dmId,
        content: trimmed,
        author: {
          id: currentUser.id,
          name: currentUser.name,
          avatar: currentUser.avatar,
        },
      })
      if (!receipt.accepted) {
        toast("Failed to send message")
        return
      }
      void receipt.committed
    }
    cancelPendingNavigation()
    router.push(`/c/me/${dmId}`)
  }

  const onUploadAvatar = () => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "image/png,image/jpeg,image/webp"
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      const check = validateIconSourceFile(file)
      if (!check.ok) {
        toast(check.error)
        return
      }
      setPendingAvatarCrop({ src: URL.createObjectURL(file), fileName: file.name })
    }
    input.click()
  }

  const onSaveProfile: ComponentProps<typeof UserSettings>["onSave"] = async (data) => {
    try {
      await updateProfile.mutateAsync(data)
      setCurrentUser((user) => ({
        ...user,
        ...(data.name ? { name: data.name } : {}),
        ...(data.aboutMe !== undefined ? { aboutMe: data.aboutMe } : {}),
        ...(data.statusEmoji !== undefined ? { statusEmoji: data.statusEmoji } : {}),
        ...(data.statusText !== undefined ? { statusText: data.statusText } : {}),
      }))
      if (data.statusEmoji !== undefined || data.statusText !== undefined) {
        useCommunityWsStore.getState().setUserStatus(
          currentUser.id,
          data.statusEmoji ?? null,
          data.statusText ?? null,
        )
      }
    } catch (error) {
      toastApiError(error, "Failed to save profile")
    }
  }

  const onLogout = async () => {
    cancelPendingNavigation()
    useCommunityStore.getState().reset()
    useCommunityWsStore.getState().reset()
    useMessageStreamStore.getState().resetAll()
    queryClient.clear()
    await clearPersistedCache(currentUser.id).catch(() => {})
    await signOut()
    router.push("/sign-in")
  }

  const userSettingsProps: ComponentProps<typeof UserSettings> = {
    onClose: () => setEditingProfile(false),
    userId: currentUser.id,
    userName: currentUser.name,
    aboutMe: currentUser.aboutMe ?? "",
    avatar: currentUser.avatar,
    statusEmoji: currentUser.statusEmoji,
    statusText: currentUser.statusText,
    onUploadAvatar,
    onSave: onSaveProfile,
    onLogout,
  }

  let pendingAvatarCropProps: Omit<ComponentProps<typeof ImageCropDialog>, "maskShape"> | null = null
  if (pendingAvatarCrop) {
    pendingAvatarCropProps = {
      imageSrc: pendingAvatarCrop.src,
      originalFileName: pendingAvatarCrop.fileName,
      onCropped: (file) => {
        uploadUserAvatar.mutate(
          { file },
          {
            onSuccess: (data) => {
              setCurrentUser((user) => ({ ...user, avatar: `${data.url}?t=${Date.now()}` }))
              toast("Avatar updated")
            },
            onError: (error) => toastApiError(error, "Failed to upload avatar"),
          },
        )
        URL.revokeObjectURL(pendingAvatarCrop.src)
        setPendingAvatarCrop(null)
      },
      onCancel: () => {
        URL.revokeObjectURL(pendingAvatarCrop.src)
        setPendingAvatarCrop(null)
      },
    }
  }

  return {
    currentUser,
    openProfile,
    previewImage,
    previewAttachment,
    profile,
    closeProfile: () => setProfile(null),
    profileMessage,
    updateOwnStatus,
    preview,
    closePreview: () => setPreview(null),
    attachmentPreview,
    onAttachmentPreviewOpenChange: (open: boolean) => {
      if (!open) setAttachmentPreview(null)
    },
    editingProfile,
    openUserSettings: () => setEditingProfile(true),
    onUserSettingsOpenChange: (open: boolean) => {
      if (!open) setEditingProfile(false)
    },
    userSettingsProps,
    pendingAvatarCrop: pendingAvatarCropProps,
  }
}
