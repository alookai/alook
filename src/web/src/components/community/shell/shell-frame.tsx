"use client"

import { useCallback, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useCommunityOnboarding } from "@/lib/community-onboarding"
import {
  communityServerId,
  resolveCommunityRoute,
  resolveServerSwitchCheckpoint,
} from "@/lib/community/community-route"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityStore } from "@/stores/community"
import { ShellFrameView } from "./shell-frame-view"
import { useShellRailController } from "./use-shell-rail-controller"
import { useShellProfileController } from "./use-shell-profile-controller"
import { useShellInboxController } from "./use-shell-inbox-controller"
import { useCommunityNavigationController } from "./use-community-navigation-controller"
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
  const queryClient = useQueryClient()
  const breakpoint = useBreakpoint()
  const onboardingState = useCommunityOnboarding()
  const navigation = useCommunityNavigationController()
  const replacePath = navigation.replace
  const pathname = navigation.currentHref.split("?")[0]!
  const route = resolveCommunityRoute(pathname)
  const pendingPathname = navigation.pendingHref?.split("?")[0]
  const pendingRoute = pendingPathname ? resolveCommunityRoute(pendingPathname) : null
  const pendingServerId = navigation.pendingHref
    ? communityServerId(navigation.pendingHref)
    : null
  const serverSwitch = resolveServerSwitchCheckpoint({
    currentHref: navigation.currentHref,
    pendingHref: navigation.pendingHref,
    hasExactServerDetail: pendingServerId
      ? queryClient.getQueryData(communityKeys.server(pendingServerId)) !== undefined
      : false,
  })
  const coldServerSwitchTargetId = serverSwitch?.cold
    ? serverSwitch.targetServerId
    : null
  const warmServerSwitch = serverSwitch != null && !serverSwitch.cold

  const rail = useShellRailController({
    navigation,
    queryClient,
    breakpoint,
    view,
    activeServerId,
    projectedActiveServerId: coldServerSwitchTargetId ?? activeServerId,
    onOpenActiveServerSettings,
    onOpenActiveServerInvite,
  })
  const profile = useShellProfileController({
    router: navigation,
    queryClient,
    cancelPendingNavigation: navigation.cancelPendingNavigation,
    view,
    activeServerId,
  })
  const inbox = useShellInboxController({
    router: navigation,
    queryClient,
    cancelPendingNavigation: navigation.cancelPendingNavigation,
  })
  const goBackMobile = useCallback(() => {
    if (route.parentPath) navigation.replace(route.parentPath)
  }, [navigation, route.parentPath])

  useEffect(() => {
    if (
      breakpoint !== "mobile" ||
      onboardingState?.status !== "active" ||
      onboardingState.stage !== "server" ||
      route.surface !== "detail" ||
      !route.parentPath
    ) return
    replacePath(route.parentPath)
  }, [breakpoint, onboardingState, replacePath, route.parentPath, route.surface])

  useEffect(() => {
    useCommunityStore.getState().registerUiHandlers({
      previewImage: profile.previewImage,
      previewAttachment: profile.previewAttachment,
      openProfile: profile.openProfile,
      goBackMobile,
      navigatePath: navigation.push,
      replacePath: navigation.replace,
      navigate: rail.navigate,
      cancelPendingNavigation: navigation.cancelPendingNavigation,
    })
  }, [
    goBackMobile,
    profile.openProfile,
    profile.previewAttachment,
    profile.previewImage,
    rail.navigate,
    navigation.cancelPendingNavigation,
    navigation.push,
    navigation.replace,
  ])

  return (
    <ShellFrameView
      breakpoint={breakpoint}
      surface={warmServerSwitch ? route.surface : pendingRoute?.surface ?? route.surface}
      loadingHref={warmServerSwitch
        ? navigation.currentHref
        : navigation.pendingHref ?? navigation.currentHref}
      sidebar={sidebar}
      extraDialogs={extraDialogs}
      cancelPendingNavigation={navigation.cancelPendingNavigation}
      navigationPending={navigation.navigationPending && !warmServerSwitch}
      serverSwitchTargetId={coldServerSwitchTargetId}
      rail={rail}
      profile={profile}
      inbox={inbox}
    >
      {children}
    </ShellFrameView>
  )
}
