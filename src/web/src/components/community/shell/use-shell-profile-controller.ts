"use client"

import { useCallback, useState, type ComponentProps } from "react"
import { parseNameAndTag } from "@alook/shared"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { userProfileQueryFn, PROFILE_STALE_TIME_MS } from "@/hooks/community/use-user-profile"
import { validateIconSourceFile } from "@/lib/community/image-crop"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import type {
  OwnerProfileRef,
  Profile,
} from "@/components/community/social/profile-types"
import {
  resolveProfileContextLabel,
  resolveProfileServerId,
  resolveProfileTarget,
  resolveProfileUserId,
} from "@/components/community/social/profile-lookup"
import { signOut } from "@/lib/auth-client"
import { clearPersistedCache } from "@/lib/query-persister"
import { disposeAccountReadStateReconciliation } from "@/hooks/community/community-ws/read-state-reconciliation"
import { disposeReadCoordinator } from "@/hooks/community/read-coordinator"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useFriends } from "@/hooks/community/use-friends"
import { useServerMembers } from "@/hooks/community/use-server-members"
import {
  useCreateOrGetDm,
  useUpdateProfile,
  useUploadUserAvatar,
  type UpdateProfileResult,
} from "@/hooks/community/mutations"
import { useDmMessageSender } from "@/hooks/community/use-dm-message-sender"
import type { UserSettings } from "@/components/community/settings/user-settings"
import type { ImageCropDialog } from "@/components/community/image-crop-dialog"
import type { QueryClient } from "@tanstack/react-query"
import type { CommunityProfileSnapshot } from "@/lib/community/models/people"
import type { ShellFrameProps, ShellRouter } from "./shell-frame-types"

export type ShellProfileState = {
  data: Profile
  x: number
  y: number
}

type Options = Pick<ShellFrameProps, "view" | "activeServerId"> & {
  router: ShellRouter
  queryClient: QueryClient
  cancelPendingNavigation: () => void
}

function commitCanonicalSelfProfile(
  snapshot: CommunityProfileSnapshot,
  profile: UpdateProfileResult,
) {
  const profiles = useCommunityWsStore.getState()
  profiles.commitProfiles(snapshot, [{
    id: profile.id,
    identityAbout: {
      name: profile.name,
      discriminator: profile.discriminator,
      aboutMe: profile.aboutMe,
      bannerColor: profile.bannerColor,
    },
    avatar: {
      avatar: profile.avatar,
      avatarVersion: profile.avatarVersion,
    },
    status: {
      statusEmoji: profile.statusEmoji,
      statusText: profile.statusText,
    },
  }])
}

export function useShellProfileController({
  router,
  queryClient,
  cancelPendingNavigation,
  view,
  activeServerId,
}: Options) {
  const currentUser = useCurrentUser()
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

  const openProfileAt = useCallback((
    name: string,
    x: number,
    y: number,
    discriminator?: string,
    targetUserId?: string,
  ) => {
    const isSelf = !!targetUserId && targetUserId === currentUser.id
    if (isSelf) {
      const selfMember = profileServerId
        ? members.find((member) => member.userId === currentUser.id)
        : undefined
      setProfile({
        data: {
          userId: currentUser.id,
          contextLabel: resolveProfileContextLabel(profileServerId, selfMember),
          mutual: 0,
          identity: { kind: "human" },
        },
        x,
        y,
      })
      return
    }

    const member = resolveProfileTarget(members, friends, {
      name,
      discriminator,
      userId: targetUserId,
    })
    const userId = resolveProfileUserId(member, targetUserId)
    setProfile({
      data: {
        ...(userId ? { userId } : { name, discriminator }),
        contextLabel: resolveProfileContextLabel(profileServerId, member),
        mutual: 0,
      },
      x,
      y,
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
            previous?.data.userId === profileResponse.id
              ? {
                ...previous,
                data: {
                  ...previous.data,
                  mutual: profileResponse.mutualServers ?? 0,
                  identity: profileResponse.kind === "bot"
                    ? {
                        kind: "bot",
                        ownerProfile: profileResponse.ownerProfile,
                        ownedByViewer: profileResponse.ownedByViewer,
                      }
                    : { kind: "human" },
                },
              }
              : previous,
          )
        })
        .catch((error) => toastApiError(error, "Failed to load profile"))
    }
  }, [currentUser, friends, members, profileServerId, queryClient])

  const openProfile = useCallback((
    name: string,
    event: React.MouseEvent,
    discriminator?: string,
    targetUserId?: string,
  ) => {
    openProfileAt(name, event.clientX, event.clientY, discriminator, targetUserId)
  }, [openProfileAt])

  const openOwnerProfile = useCallback((owner: OwnerProfileRef) => {
    if (!profile) return
    const parsed = parseNameAndTag(owner.handle)
    if (!parsed) return
    openProfileAt(
      parsed.name,
      profile.x,
      profile.y,
      parsed.discriminator,
      owner.id,
    )
  }, [openProfileAt, profile])

  const openBotAudit = useCallback((botId: string) => {
    cancelPendingNavigation()
    router.push(`/c/me/bots?audit=${encodeURIComponent(botId)}`)
    setProfile(null)
  }, [cancelPendingNavigation, router])

  const previewImage = useCallback((image: ImagePreview) => setPreview(image), [])
  const previewAttachment = useCallback(
    (attachment: FileAttachment) => setAttachmentPreview(attachment),
    [],
  )

  const updateOwnStatus = async (statusEmoji: string | null, statusText: string | null) => {
    try {
      const snapshot = useCommunityWsStore.getState().beginProfileSnapshot()
      const profile = await updateProfile.mutateAsync({ statusEmoji, statusText })
      commitCanonicalSelfProfile(snapshot, profile)
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
      const snapshot = useCommunityWsStore.getState().beginProfileSnapshot()
      const profile = await updateProfile.mutateAsync(data)
      commitCanonicalSelfProfile(snapshot, profile)
    } catch (error) {
      toastApiError(error, "Failed to save profile")
    }
  }

  const onLogout = async () => {
    cancelPendingNavigation()
    useCommunityStore.getState().reset()
    useCommunityWsStore.getState().reset()
    useMessageStreamStore.getState().resetAll()
    disposeReadCoordinator(queryClient)
    disposeAccountReadStateReconciliation(queryClient)
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
              const profiles = useCommunityWsStore.getState()
              profiles.patchProfiles(profiles.beginProfileSnapshot(), [{
                id: currentUser.id,
                avatar: { avatar: data.url, avatarVersion: data.avatarVersion },
              }])
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
    openOwnerProfile,
    openBotAudit,
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
