"use client"

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react"
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
import {
  hasStructuralServerTree,
  useStructuralSnapshot,
} from "@/hooks/community/use-structural-snapshot"
import {
  initialUserBarExtensionState,
  userBarExtensionReducer,
} from "./user-bar-extension-state"
import { useShellDaemonUpdateController } from "./use-shell-daemon-update-controller"

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
  const structuralSnapshot = useStructuralSnapshot(currentUser.id, queryClient)
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
  const targetServerId = target?.scope.kind === "server" ? target.scope.serverId : null
  const structuralTarget = targetServerId
    ? structuralSnapshot?.servers.find((server) => server.id === targetServerId)
    : null
  const targetReady = targetServerId
    ? queryClient.getQueryData(communityKeys.server(targetServerId)) !== undefined
      // `replaceServers` can seed a rail-only identity with an empty tree.
      // Only a snapshot containing actual tree structure can replace the
      // target-scoped cold checkpoint.
      || hasStructuralServerTree(structuralTarget)
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
    accountId: currentUser.id,
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
  const [userBarExtension, dispatchUserBarExtension] = useReducer(
    userBarExtensionReducer,
    initialUserBarExtensionState,
  )
  const daemonUpdate = useShellDaemonUpdateController({
    userId: currentUser.id,
    extensionState: userBarExtension,
    dispatch: dispatchUserBarExtension,
  })
  const onUserBarInboxOpenChange = useCallback((open: boolean) => {
    if (!open) {
      inbox.onOpenChange(false)
      dispatchUserBarExtension({ type: "extension.close", extension: "inbox" })
      return
    }
    if (userBarExtension.active === "profile") profile.closeProfile()
    if (userBarExtension.active === "update") daemonUpdate.collapse()
    inbox.onOpenChange(true)
    dispatchUserBarExtension({ type: "extension.open", extension: "inbox" })
  }, [daemonUpdate, inbox, profile, userBarExtension.active])
  const onUserBarOpenProfile = useCallback<ReturnType<typeof useShellProfileController>["openProfile"]>((
    name,
    event,
    discriminator,
    targetUserId,
  ) => {
    if (userBarExtension.active === "profile") {
      profile.closeProfile()
      dispatchUserBarExtension({ type: "extension.close", extension: "profile" })
      return
    }
    if (userBarExtension.active === "inbox") inbox.onOpenChange(false)
    if (userBarExtension.active === "update") daemonUpdate.collapse()
    profile.openProfile(name, event, discriminator, targetUserId)
    dispatchUserBarExtension({ type: "extension.open", extension: "profile" })
  }, [daemonUpdate, inbox, profile, userBarExtension.active])
  const onUserBarOpenUpdate = useCallback(() => {
    if (userBarExtension.active === "inbox") inbox.onOpenChange(false)
    if (userBarExtension.active === "profile") profile.closeProfile()
    daemonUpdate.open()
  }, [daemonUpdate, inbox, profile, userBarExtension.active])
  const dismissUserBarExtension = useCallback(() => {
    if (userBarExtension.active === "inbox") inbox.onOpenChange(false)
    if (userBarExtension.active === "profile") profile.closeProfile()
    if (userBarExtension.active === "update") daemonUpdate.collapse()
    dispatchUserBarExtension({
      type: "extension.close",
      extension: userBarExtension.active,
    })
  }, [daemonUpdate, inbox, profile, userBarExtension.active])
  const goBackMobile = useCallback(() => {
    if (route.parentPath) navigation.replace(route.parentPath)
  }, [navigation, route.parentPath])

  useEffect(() => {
    if (userBarExtension.active === "inbox" && !inbox.open) {
      dispatchUserBarExtension({ type: "extension.close", extension: "inbox" })
    }
  }, [inbox.open, userBarExtension.active])

  useEffect(() => {
    if (userBarExtension.active !== "profile") return
    if (profile.profile?.data.userId === currentUser.id) return
    dispatchUserBarExtension({ type: "extension.close", extension: "profile" })
  }, [currentUser.id, profile.profile, userBarExtension.active])

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
      userBarExtension={userBarExtension}
      daemonUpdate={daemonUpdate}
      onUserBarInboxOpenChange={onUserBarInboxOpenChange}
      onUserBarOpenProfile={onUserBarOpenProfile}
      onUserBarOpenUpdate={onUserBarOpenUpdate}
      dismissUserBarExtension={dismissUserBarExtension}
    >
      {children}
    </ShellFrameView>
  )
}
