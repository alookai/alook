"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useCommunityOnboarding } from "@/lib/community-onboarding"
import {
  advanceCommunityCommittedFrame,
  normalizeCommunityHref,
  resolveCommunityCheckpointPlan,
  resolveCommunityRoute,
  type CommunityCommittedFrame,
} from "@/lib/community/community-route"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useCurrentUser } from "@/contexts/community/current-user"
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
    frameHref,
    sidebar,
    children,
    extraDialogs,
    onOpenActiveServerSettings,
    onOpenActiveServerInvite,
  } = props
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const breakpoint = useBreakpoint()
  const onboardingState = useCommunityOnboarding()
  const initialCommittedFrame: CommunityCommittedFrame = {
    ...normalizeCommunityHref(frameHref),
    revision: 0,
  }
  const committedFrameRef = useRef(initialCommittedFrame)
  const [committedFrame, setCommittedFrame] = useState(initialCommittedFrame)
  const commitFrame = useCallback((href: string) => {
    const current = committedFrameRef.current
    const next = advanceCommunityCommittedFrame(current, href)
    if (next === current) return
    committedFrameRef.current = next
    setCommittedFrame(next)
  }, [])
  useLayoutEffect(() => commitFrame(frameHref), [commitFrame, frameHref])
  const navigation = useCommunityNavigationController(committedFrame)
  const replacePath = navigation.replace
  const route = resolveCommunityRoute(committedFrame.pathname)
  const target = navigation.pendingHref
    ? normalizeCommunityHref(navigation.pendingHref)
    : null
  const targetReady = target?.scope.kind === "server"
    ? queryClient.getQueryData(communityKeys.server(target.scope.serverId)) !== undefined
    : target?.scope.kind === "me"
      ? queryClient.getQueryData(communityKeys.dms()) !== undefined
      : false
  const checkpoint = resolveCommunityCheckpointPlan({
    committedFrame,
    targetHref: navigation.pendingHref,
    pending: navigation.navigationPending,
    targetReady,
  })
  const projectedView = checkpoint.rail.kind === "target"
    ? checkpoint.rail.view
    : view
  const projectedActiveServerId = checkpoint.rail.kind === "target"
    ? checkpoint.rail.activeServerId
    : activeServerId

  const rail = useShellRailController({
    navigation,
    queryClient,
    breakpoint,
    view,
    activeServerId,
    projectedView,
    projectedActiveServerId,
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
    publishedHref: navigation.publishedHref,
    navigationPending: navigation.navigationPending,
    pendingHref: navigation.pendingHref,
    viewerId: currentUser.id,
    accessEpoch,
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
      checkpoint={checkpoint}
      sidebar={sidebar}
      extraDialogs={extraDialogs}
      cancelPendingNavigation={navigation.cancelPendingNavigation}
      rail={rail}
      profile={profile}
      inbox={inbox}
    >
      {children}
    </ShellFrameView>
  )
}
