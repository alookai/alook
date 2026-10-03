"use client"
import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { useCommunityRuntime } from "@/stores/community/runtime"


import { useCallback, useMemo, type ComponentProps } from "react"
import { useQuery } from "@tanstack/react-query"
import { useCanonicalCommunityProfile } from "@/lib/community-db/projections"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { usePathname, useSearchParams } from "next/navigation"
import { readBillingReturn } from "@/hooks/community/use-billing"
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
import { useAccountSignOut } from "@/hooks/community/use-account-sign-out"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { disposeAccountReadStateReconciliation } from "@/hooks/community/community-ws/read-state-reconciliation"
import { disposeReadCoordinator } from "@/hooks/community/read-coordinator"


import { useCurrentUser } from "@/contexts/community/current-user"
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
  const communityRuntime = useCommunityRuntime()
  const source = useCommunityViewSource(JSON.stringify(["shell-profile", view, activeServerId]))
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const billingReturn = readBillingReturn(searchParams.get("billing"))
  const billingRequested = searchParams.get("settings") === "billing" || Boolean(billingReturn)
  const closeSettings = () => {
    setEditingProfile(false)
    if (billingRequested) {
      const next = new URLSearchParams(searchParams.toString())
      next.delete("settings")
      next.delete("billing")
      window.history.replaceState(null, "", `${pathname}${next.size ? `?${next}` : ""}${window.location.hash}`)
    }
  }
  const currentUser = useCurrentUser()
  const { friends } = useFriends()
  const profileServerId = resolveProfileServerId(view, activeServerId)
  const { members } = useServerMembers(profileServerId)
  const createOrGetDm = useCreateOrGetDm()
  const { accept: acceptDmMessage } = useDmMessageSender()
  const updateProfile = useUpdateProfile()
  const uploadUserAvatar = useUploadUserAvatar()

  const [editingProfile, setEditingProfile] = useAtom(useCreateAtom(false))
  const [profileTarget, setProfile] = useAtom(useCreateAtom<ShellProfileState | null>(null))
  const [preview, setPreview] = useAtom(useCreateAtom<ImagePreview | null>(null))
  const [attachmentPreview, setAttachmentPreview] = useAtom(useCreateAtom<FileAttachment | null>(null))
  const [pendingAvatarCrop, setPendingAvatarCrop] = useAtom(useCreateAtom<{
    src: string
    fileName: string
  } | null>(null))
  const profileUserId = profileTarget?.data.userId
  const canonicalProfile = useCanonicalCommunityProfile(profileUserId)
  useQuery({ queryKey: communityKeys.profile(profileUserId ?? "__none__"), enabled: !!profileUserId && profileUserId !== currentUser.id,
    queryFn: userProfileQueryFn(profileUserId ?? ""), staleTime: PROFILE_STALE_TIME_MS })
  const profile = useMemo<ShellProfileState | null>(() => profileTarget ? {
    ...profileTarget,
    data: {
      ...profileTarget.data,
      contextLabel: resolveProfileContextLabel(profileServerId, members.find((member) => member.userId === profileUserId)),
      mutual: canonicalProfile?.mutualServers ?? 0,
      identity: canonicalProfile?.kind === "bot" && canonicalProfile.ownerUserId && canonicalProfile.ownerHandle
        ? { kind: "bot", ownerProfile: { id: canonicalProfile.ownerUserId, handle: canonicalProfile.ownerHandle }, ownedByViewer: canonicalProfile.ownedByViewer ?? false }
        : canonicalProfile?.kind === "human" || profileUserId === currentUser.id ? { kind: "human" } : undefined,
    },
  } : null, [profileTarget, profileServerId, members, profileUserId, canonicalProfile, currentUser.id])

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
  }, [currentUser.id, friends, members, profileServerId, setProfile])

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
  }, [cancelPendingNavigation, router, setProfile])

  const previewImage = useCallback((image: ImagePreview) => setPreview(image), [setPreview])
  const previewAttachment = useCallback(
    (attachment: FileAttachment) => setAttachmentPreview(attachment),
    [setAttachmentPreview],
  )

  const updateOwnStatus = async (statusEmoji: string | null, statusText: string | null) => {
    const assert = source.capture()
    try {
      await updateProfile.mutateAsync({ statusEmoji, statusText, assertActive: assert })
      assert()
    } catch (error) {
      toastApiError(error, "Failed to update status", assert)
    }
  }

  const profileMessage = async (userId: string, text: string) => {
    const assert = source.capture()
    assert()
    if (!userId) {
      toast("Could not find user")
      return
    }
    cancelPendingNavigation()
    let dmId: string
    try {
      const data = await createOrGetDm.mutateAsync({ userId, assertActive: assert })
      assert()
      dmId = data.conversation.id
    } catch (error) {
      toastApiError(error, "Failed to open DM", assert)
      return
    }
    const trimmed = text.trim()
    if (trimmed) {
      const receipt = acceptDmMessage({
        assertActive: assert,
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
    router.push(`/c/me/${dmId}`)
  }

  const onUploadAvatar = () => {
    const assert = source.capture()
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "image/png,image/jpeg,image/webp"
    input.onchange = () => {
      try { assert() } catch { return }
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
    const assert = source.capture()
    try {
      await updateProfile.mutateAsync({ ...data, assertActive: assert })
      assert()
    } catch (error) {
      toastApiError(error, "Failed to save profile", assert)
    }
  }

  const clearVolatileAccountState = () => {
    cancelPendingNavigation()
    communityRuntime.ui.actions.reset()
    communityRuntime.ws.actions.reset()
    communityRuntime.messageStream.actions.resetAll()
    disposeReadCoordinator(queryClient)
    disposeAccountReadStateReconciliation(queryClient)
    queryClient.clear()
  }

  const logout = useAccountSignOut()
  const onLogout = async () => {
    const token = captureCommunityLiveSnapshotToken(queryClient)
    try { if (await logout.mutateAsync()) globalThis.location.replace("/sign-in") }
    catch (error) { toastApiError(error, "Failed to log out", () => assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)) }
  }

  const onAccountDeleted = async () => {
    clearVolatileAccountState()
    setEditingProfile(false)
  }

  const userSettingsProps: ComponentProps<typeof UserSettings> = {
    onClose: closeSettings,
    initialTab: billingRequested ? "billing" : "profile",
    billingReturn,
    userId: currentUser.id,
    userName: currentUser.name,
    userEmail: currentUser.email,
    aboutMe: currentUser.aboutMe ?? "",
    avatar: currentUser.avatar,
    statusEmoji: currentUser.statusEmoji,
    statusText: currentUser.statusText,
    onUploadAvatar,
    onSave: onSaveProfile,
    onLogout,
    onAccountDeleted,
  }

  let pendingAvatarCropProps: Omit<ComponentProps<typeof ImageCropDialog>, "maskShape"> | null = null
  if (pendingAvatarCrop) {
    pendingAvatarCropProps = {
      imageSrc: pendingAvatarCrop.src,
      originalFileName: pendingAvatarCrop.fileName,
      onCropped: (file) => {
        const assert = source.capture()
        uploadUserAvatar.mutate(
          { file, assertActive: assert },
          {
            onSuccess: () => {
              try { assert() } catch { return }
              toast("Avatar updated")
            },
            onError: (error) => toastApiError(error, "Failed to upload avatar", assert),
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
    editingProfile: editingProfile || billingRequested,
    openUserSettings: () => setEditingProfile(true),
    onUserSettingsOpenChange: (open: boolean) => {
      if (!open) closeSettings()
    },
    userSettingsProps,
    pendingAvatarCrop: pendingAvatarCropProps,
  }
}
