"use client"

import { useCallback, useEffect } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useCommunityOnboarding } from "@/lib/community-onboarding"
import { useCommunityStore } from "@/stores/community"
import { ShellFrameView } from "./shell-frame-view"
import { useShellRailController } from "./use-shell-rail-controller"
import { useShellProfileController } from "./use-shell-profile-controller"
import { useShellInboxController } from "./use-shell-inbox-controller"
import { resolveMobileZone, withMobileZone } from "./mobile-zone"
import type { ShellFrameProps } from "./shell-frame-types"

/** Shared community shell orchestration for the server and DM layouts. */
export function ShellFrame(props: ShellFrameProps) {
  const {
    view,
    activeServerId,
    sidebar,
    children,
    extraDialogs,
    onOpenActiveServerSettings,
    onOpenActiveServerInvite,
  } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const breakpoint = useBreakpoint()
  const onboardingState = useCommunityOnboarding()
  const search = searchParams.toString()
  const currentHref = search ? `${pathname}?${search}` : pathname
  const mobileZone = resolveMobileZone(searchParams)

  useEffect(() => {
    if (breakpoint !== "mobile" || onboardingState?.status !== "active") return
    const browserHref = `${currentHref}${window.location.hash}`
    const nextHref = withMobileZone(
      browserHref,
      onboardingState.stage === "server" ? "nav" : "messages",
    )
    if (nextHref !== browserHref) window.history.replaceState(null, "", nextHref)
  }, [breakpoint, currentHref, onboardingState])

  const rail = useShellRailController({
    router,
    queryClient,
    breakpoint,
    currentHref,
    view,
    activeServerId,
    onOpenActiveServerSettings,
    onOpenActiveServerInvite,
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
  const goBackMobile = useCallback(() => {
    const browserHref = `${currentHref}${window.location.hash}`
    const nextHref = withMobileZone(browserHref, "nav")
    if (nextHref !== browserHref) window.history.replaceState(null, "", nextHref)
  }, [currentHref])

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
      navigationPending={rail.navigationPending}
      rail={rail}
      profile={profile}
      inbox={inbox}
    >
      {children}
    </ShellFrameView>
  )
}
