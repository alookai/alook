"use client"

import type { ReactNode } from "react"
import type { Breakpoint } from "@/hooks/use-mobile"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { UserSettings } from "../settings/user-settings"
import { ProfileCard } from "../social/profile-card"
import { ImageLightbox } from "../messages/image-lightbox"
import { AttachmentPreviewSheet } from "../messages/attachment-preview-sheet"
import { ImageCropDialog } from "../image-crop-dialog"
import type { useShellProfileController } from "./use-shell-profile-controller"

type ProfileController = ReturnType<typeof useShellProfileController>

export function ShellFrameOverlays({
  controller,
  breakpoint,
  profileStatusSeeds,
  extraDialogs,
}: {
  controller: ProfileController
  breakpoint: Breakpoint
  profileStatusSeeds?: {
    initialStatusEmoji: string | null
    initialStatusText: string | null
  }
  extraDialogs?: ReactNode
}) {
  const { profile, currentUser } = controller
  const pendingAvatarCrop = controller.pendingAvatarCrop
  return (
    <>
      {profile && (
        <ProfileCard
          key={`${profile.data.userId ?? profile.data.name}:${profile.x}:${profile.y}`}
          data={profile.data}
          x={profile.x}
          y={profile.y}
          bp={breakpoint}
          onClose={controller.closeProfile}
          onMessage={controller.profileMessage}
          isSelf={!!profile.data.userId && profile.data.userId === currentUser.id}
          onUpdateStatus={controller.updateOwnStatus}
          {...profileStatusSeeds}
        />
      )}
      {controller.preview && (
        <ImageLightbox image={controller.preview} onClose={controller.closePreview} />
      )}
      <AttachmentPreviewSheet
        attachment={controller.attachmentPreview}
        open={!!controller.attachmentPreview}
        onOpenChange={controller.onAttachmentPreviewOpenChange}
      />
      <Dialog
        open={controller.editingProfile}
        onOpenChange={controller.onUserSettingsOpenChange}
      >
        <DialogContent
          className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[calc(100vh-4rem)] sm:max-h-180 sm:w-[calc(100vw-4rem)] sm:max-w-4xl sm:rounded-xl"
          showCloseButton={false}
        >
          <UserSettings {...controller.userSettingsProps} />
        </DialogContent>
      </Dialog>
      {pendingAvatarCrop && (
        <ImageCropDialog
          {...pendingAvatarCrop}
          maskShape="circle"
        />
      )}
      {extraDialogs}
    </>
  )
}
