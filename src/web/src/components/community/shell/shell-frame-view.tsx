"use client"

import { ChannelSidebarSkeleton } from "@/components/community/channels/channel-sidebar"
import { DmSidebarSkeleton } from "@/components/community/channels/dm-sidebar"
import { CommunityPendingFrame } from "./community-pending-frame"
import { ServerRail } from "./server-rail"
import { UserBar } from "./user-bar"
import { InboxPopover } from "./community-inbox-popover"
import { ShellFrameOverlays } from "./shell-frame-overlays"
import { CommunityShellLayout } from "./community-shell-layout"
import { ProfileCard } from "../social/profile-card"
import type { Breakpoint } from "@/hooks/use-mobile"
import type { CommunityCheckpointPlan } from "@/lib/community/community-route"
import type { ShellFrameProps } from "./shell-frame-types"
import type { useShellRailController } from "./use-shell-rail-controller"
import type { useShellProfileController } from "./use-shell-profile-controller"
import type { useShellInboxController } from "./use-shell-inbox-controller"
import type { useShellDaemonUpdateController } from "./use-shell-daemon-update-controller"
import type { UserBarExtensionState } from "./user-bar-extension-state"
import { userBarUpdateBadgePhase } from "./user-bar-extension-state"
import type { OpenProfile } from "../social/profile-types"

type Props = Pick<ShellFrameProps, "sidebar" | "children" | "extraDialogs"> & {
  breakpoint: Breakpoint
  checkpoint: CommunityCheckpointPlan
  cancelPendingNavigation: () => void
  rail: ReturnType<typeof useShellRailController>
  profile: ReturnType<typeof useShellProfileController>
  inbox: ReturnType<typeof useShellInboxController>
  userBarExtension: UserBarExtensionState
  daemonUpdate: ReturnType<typeof useShellDaemonUpdateController>
  onUserBarInboxOpenChange: (open: boolean) => void
  onUserBarOpenProfile: OpenProfile
  onUserBarOpenUpdate: () => void
  dismissUserBarExtension: () => void
}

export function ShellFrameView({
  breakpoint,
  checkpoint,
  sidebar,
  children,
  extraDialogs,
  cancelPendingNavigation,
  rail,
  profile,
  inbox,
  userBarExtension,
  daemonUpdate,
  onUserBarInboxOpenChange,
  onUserBarOpenProfile,
  onUserBarOpenUpdate,
  dismissUserBarExtension,
}: Props) {
  const { surface } = checkpoint
  const inboxElement = (
    <InboxPopover
      {...inbox.popoverProps}
      surface="extension"
    />
  )
  const user = {
    id: profile.currentUser.id,
    name: profile.currentUser.name,
    avatar: profile.currentUser.avatar,
  }
  const isInitial = breakpoint === "unknown"
  const profileInExtension = userBarExtension.active === "profile"
    && profile.profile?.data.userId === profile.currentUser.id
  const profileElement = profileInExtension && profile.profile ? (
    <ProfileCard
      data={profile.profile.data}
      x={profile.profile.x}
      y={profile.profile.y}
      bp={breakpoint}
      onClose={profile.closeProfile}
      onMessage={profile.profileMessage}
      isSelf
      onUpdateStatus={profile.updateOwnStatus}
      onOpenOwnerProfile={profile.openOwnerProfile}
      onOpenBotAudit={profile.openBotAudit}
      extension
    />
  ) : null

  return (
    <CommunityShellLayout
      breakpoint={breakpoint}
      surface={surface}
      onNavigationIntent={cancelPendingNavigation}
      transition={{ mode: checkpoint.mode, targetHref: checkpoint.targetHref }}
      rail={<ServerRail {...rail.railProps} bottomInset={60} />}
      sidebar={checkpoint.sidebar.kind === "server-skeleton"
          ? <ChannelSidebarSkeleton targetServerId={checkpoint.sidebar.serverId} />
          : checkpoint.sidebar.kind === "me-skeleton"
            ? <DmSidebarSkeleton />
            : breakpoint === "desktop" ? sidebar() : sidebar({ noHeader: false })}
      main={checkpoint.main.kind === "target-skeleton" || isInitial ? (
        <CommunityPendingFrame
          href={checkpoint.targetHref}
          reserveBackSlot={surface === "detail"}
        />
      ) : children}
      userBar={(
        <UserBar
          breakpoint={breakpoint}
          user={user}
          onOpenProfile={onUserBarOpenProfile}
          onEditProfile={profile.openUserSettings}
          inbox={inboxElement}
          hasUnread={inbox.hasUnread}
          inboxOpen={userBarExtension.active === "inbox"}
          onInboxOpenChange={onUserBarInboxOpenChange}
          extension={{
            active: userBarExtension.active,
            inbox: inboxElement,
            profile: profileElement,
            update: daemonUpdate.update,
            updateBadgePhase: userBarUpdateBadgePhase(userBarExtension),
            eligibleMachines: daemonUpdate.eligibleMachines,
            onOpenUpdate: onUserBarOpenUpdate,
            onRequestUpdate: daemonUpdate.request,
            onDismiss: dismissUserBarExtension,
          }}
        />
      )}
      overlays={!isInitial && (
        <ShellFrameOverlays
          controller={profile}
          breakpoint={breakpoint}
          extraDialogs={extraDialogs}
          suppressProfileCard={profileInExtension}
        />
      )}
    />
  )
}
