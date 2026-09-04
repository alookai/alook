"use client"

import { ChannelSidebarSkeleton } from "@/components/community/channels/channel-sidebar"
import { DmSidebarSkeleton } from "@/components/community/channels/dm-sidebar"
import { CommunityPendingFrame } from "./community-pending-frame"
import { ServerRail } from "./server-rail"
import { UserBar } from "./user-bar"
import { InboxPopover } from "./community-inbox-popover"
import { ShellFrameOverlays } from "./shell-frame-overlays"
import { CommunityShellLayout } from "./community-shell-layout"
import type { Breakpoint } from "@/hooks/use-mobile"
import type { CommunityCheckpointPlan } from "@/lib/community/community-route"
import type { ShellFrameProps } from "./shell-frame-types"
import type { useShellRailController } from "./use-shell-rail-controller"
import type { useShellProfileController } from "./use-shell-profile-controller"
import type { useShellInboxController } from "./use-shell-inbox-controller"

type Props = Pick<ShellFrameProps, "sidebar" | "children" | "extraDialogs"> & {
  breakpoint: Breakpoint
  checkpoint: CommunityCheckpointPlan
  cancelPendingNavigation: () => void
  rail: ReturnType<typeof useShellRailController>
  profile: ReturnType<typeof useShellProfileController>
  inbox: ReturnType<typeof useShellInboxController>
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
}: Props) {
  const { surface } = checkpoint
  const inboxElement = (
    <InboxPopover
      {...inbox.popoverProps}
      surface={breakpoint === "mobile" ? "mobile" : "desktop"}
    />
  )
  const user = {
    id: profile.currentUser.id,
    name: profile.currentUser.name,
    avatar: profile.currentUser.avatar,
  }
  const isInitial = breakpoint === "unknown"

  return (
    <CommunityShellLayout
      breakpoint={breakpoint}
      surface={surface}
      onNavigationIntent={cancelPendingNavigation}
      transition={{ mode: checkpoint.mode, targetHref: checkpoint.targetHref }}
      rail={<ServerRail {...rail.railProps} bottomInset={60} />}
      sidebar={breakpoint === "mobile" && surface === "detail"
        ? null
        : checkpoint.sidebar.kind === "server-skeleton"
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
          onOpenProfile={profile.openProfile}
          onEditProfile={profile.openUserSettings}
          inbox={inboxElement}
          hasUnread={inbox.hasUnread}
          inboxOpen={inbox.open}
          onInboxOpenChange={inbox.onOpenChange}
        />
      )}
      overlays={!isInitial && (
        <ShellFrameOverlays
          controller={profile}
          breakpoint={breakpoint}
          extraDialogs={extraDialogs}
        />
      )}
    />
  )
}
