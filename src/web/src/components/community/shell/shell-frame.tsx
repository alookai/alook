"use client"

import { useCallback, useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useCommunityOnboarding } from "@/lib/community-onboarding"
import { useCommunityStore } from "@/stores/community"
import { ShellFrameView } from "./shell-frame-view"
import { useShellRailController } from "./use-shell-rail-controller"
import { useShellProfileController } from "./use-shell-profile-controller"
import { useShellInboxController } from "./use-shell-inbox-controller"
import type { ShellFrameProps } from "./shell-frame-types"

/** Shared community shell orchestration for the server and DM layouts. */
export function ShellFrame(props: ShellFrameProps) {
  const {
    view,
    activeServerId,
    mobileZone,
    setMobileZone,
    sidebar,
    children,
    extraDialogs,
    onOpenActiveServerSettings,
    onOpenActiveServerInvite,
    goHome,
    goServer,
  } = props
  const router = useRouter()
  const pathname = usePathname()
  const queryClient = useQueryClient()
  const breakpoint = useBreakpoint()
  const onboardingState = useCommunityOnboarding()

  useEffect(() => {
    if (onboardingState?.status === "active") {
      setMobileZone(onboardingState.stage === "server" ? "nav" : "messages")
    }
  }, [onboardingState, setMobileZone])

  const rail = useShellRailController({
    router,
    pathname,
    queryClient,
    view,
    activeServerId,
    setMobileZone,
    onOpenActiveServerSettings,
    onOpenActiveServerInvite,
    goHome,
    goServer,
  })
  const profile = useShellProfileController({
    router,
    queryClient,
    cancelPendingNavigation: rail.cancelPendingNavigation,
    view,
    activeServerId,
  })
  const inbox = useShellInboxController({
    router,
    queryClient,
    cancelPendingNavigation: rail.cancelPendingNavigation,
  })
  const goBackMobile = useCallback(
    () => setMobileZone("nav"),
    [setMobileZone],
  )

  useEffect(() => {
    useCommunityStore.getState().registerUiHandlers({
      previewImage: profile.previewImage,
      previewAttachment: profile.previewAttachment,
      openProfile: profile.openProfile,
      goBackMobile,
      navigate: rail.navigate,
      cancelPendingNavigation: rail.cancelPendingNavigation,
    })
  }, [
    goBackMobile,
    profile.openProfile,
    profile.previewAttachment,
    profile.previewImage,
    rail.cancelPendingNavigation,
    rail.navigate,
  ])

  return (
    <ShellFrameView
      breakpoint={breakpoint}
      mobileZone={mobileZone}
      sidebar={sidebar}
      extraDialogs={extraDialogs}
      cancelPendingNavigation={rail.cancelPendingNavigation}
      rail={rail}
      profile={profile}
      inbox={inbox}
    >
      {children}
    </ShellFrameView>
  )
}
