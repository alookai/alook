"use client"

import { requestNativeBack } from "@/components/ui/native-back-layer"
import { MobilePageBackContext, type MobilePageBack } from "@/contexts/community/mobile-page-back"
import { commitNavigation } from "@/lib/observability/context"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { getCommunityRuntime } from "@/stores/community/runtime"


import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useCommunityOnboarding } from "@/lib/community-onboarding"
import {
  advanceCommunityCommittedFrame,
  channelHref,
  isPublishedNonStructuralCommit,
  normalizeCommunityHref,
  resolveCommunityCheckpointPlan,
  resolveCommunityModulePlan,
  resolveCommunityRoute,
  type CommunityCommittedFrame,
} from "@/lib/community/community-route"
import { communityKeys } from "@/lib/query-keys"

import { useCommunityWsStore } from "@/stores/community/ws"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useNativeSystemNotifications } from "@/hooks/community/use-native-system-notifications"
import { CommunityRouteContext, type NativeNotificationConversationConsumer } from "./community-route-context"
import { ShellFrameView } from "./shell-frame-view"
import { useShellRailController } from "./use-shell-rail-controller"
import { useShellProfileController } from "./use-shell-profile-controller"
import { useShellInboxController } from "./use-shell-inbox-controller"
import { useCommunityNavigationController } from "./use-community-navigation-controller"
import type { ShellFrameProps } from "./shell-frame-types"
import {
  initialUserBarExtensionState,
  userBarExtensionReducer,
} from "./user-bar-extension-state"
import { useShellDaemonUpdateController } from "./use-shell-daemon-update-controller"
import { flushOwnerServerDeleteRouteCommit } from "@/hooks/community/community-ws/scope-eviction"
import {
  observeOwnerServerDeleteRouteCommit,
  registerOwnerServerDeleteRoute,
} from "@/lib/community/eject-server"
import { useNativeMobileBack } from "@/hooks/community/use-native-mobile-back"
import {
  useRouteChannelProjection,
  useServerTreeProjection,
} from "@/lib/community-db/projections"

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
    ownerDeleteRouteScope,
  } = props
  const notificationConsumer = useRef<NativeNotificationConversationConsumer | null>(null)
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
const [committedFrame, setCommittedFrame] = useAtom(useCreateAtom(initialCommittedFrame))
  const commitFrame = useCallback((href: string) => {
    const current = committedFrameRef.current
    const next = advanceCommunityCommittedFrame(current, href)
    if (next === current) return
    committedFrameRef.current = next
    setCommittedFrame(next)
  }, [setCommittedFrame])
  useLayoutEffect(() => {
    commitFrame(frameHref)
    commitNavigation(frameHref)
    if (ownerDeleteRouteScope) {
      registerOwnerServerDeleteRoute(queryClient,
        ownerDeleteRouteScope.serverId,
        ownerDeleteRouteScope.token,
      )
    }
    observeOwnerServerDeleteRouteCommit(queryClient, frameHref)
  }, [commitFrame, frameHref, ownerDeleteRouteScope, queryClient])
  useEffect(() => {
    flushOwnerServerDeleteRouteCommit(queryClient)
  }, [frameHref, queryClient])
  const navigation = useCommunityNavigationController(committedFrame)
  const replacePath = navigation.replace
  const route = resolveCommunityRoute(committedFrame.pathname)
  const committedModule = resolveCommunityModulePlan(committedFrame.pathname)
  const committedChannelId = committedModule.main.kind === "server-conversation"
    ? committedModule.main.leafId : null
  const committedChannel = useRouteChannelProjection(committedChannelId)
  const mobileParentPath = committedModule.sidebar.kind === "server"
    && committedChannel?.id === committedChannelId
    && committedChannel.serverId === committedModule.sidebar.serverId
    && committedChannel.parentChannelId
    ? channelHref(committedModule.sidebar.serverId, committedChannel.parentChannelId)
    : route.parentPath
  const target = navigation.pendingHref
    ? normalizeCommunityHref(navigation.pendingHref)
    : null
  const targetServerId = target?.scope.kind === "server" ? target.scope.serverId : null
  const targetModulePlan = navigation.pendingHref
    ? resolveCommunityModulePlan(navigation.pendingHref)
    : null
  const targetChannelId = targetModulePlan?.main.kind === "server-conversation"
    ? targetModulePlan.main.leafId
    : null
  const targetServer = useServerTreeProjection(targetServerId)
  const targetRouteChannel = useRouteChannelProjection(targetChannelId)
  const targetChannel = targetServer?.categories
    ?.flatMap((category) => category.channels)
    .find((channel) => channel.id === targetChannelId)
    ?? targetRouteChannel
  const targetConversationSubtype = targetChannel?.type === "text"
    || targetChannel?.type === "forum"
    || targetChannel?.type === "thread"
    ? targetChannel.type
    : undefined
  const targetReady = targetServerId
    ? queryClient.getQueryData(communityKeys.server(targetServerId)) !== undefined
      || targetServer !== undefined
    : target?.scope.kind === "me"
      ? queryClient.getQueryData(communityKeys.dms()) !== undefined
      : false
  const checkpoint = resolveCommunityCheckpointPlan({
    committedFrame,
    targetHref: navigation.pendingHref,
    pending: navigation.navigationPending,
    targetReady,
    targetConversationSubtype,
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
  const [userBarExtension, setUserBarExtension] = useAtom(useCreateAtom(initialUserBarExtensionState))
  const dispatchUserBarExtension = useCallback((action: Parameters<typeof userBarExtensionReducer>[1]) => {
    setUserBarExtension((state) => userBarExtensionReducer(state, action))
  }, [setUserBarExtension])
  const daemonUpdate = useShellDaemonUpdateController({
    userId: currentUser.id,
    extensionState: userBarExtension,
    dispatch: dispatchUserBarExtension,
  })
  const applyInboxOpenChange = useCallback((open: boolean) => {
    if (!open) {
      inbox.onOpenChange(false)
      dispatchUserBarExtension({ type: "extension.close", extension: "inbox" })
      return
    }
    if (userBarExtension.active === "profile") profile.closeProfile()
    if (userBarExtension.active === "update") daemonUpdate.collapse()
    inbox.onOpenChange(true)
    dispatchUserBarExtension({ type: "extension.open", extension: "inbox" })
  }, [daemonUpdate, dispatchUserBarExtension, inbox, profile, userBarExtension.active])
  const [inboxOpenRequest, setInboxOpenRequest] = useAtom(useCreateAtom<{
    viewerId: string
    href: string
    currentFrameOnly?: boolean
    isCurrent: () => boolean
  } | null>(null))
  const requestInboxOpen = useCallback((fromUserBar: boolean) => {
    setInboxOpenRequest(null)
    const published = normalizeCommunityHref(navigation.publishedHref)
    const currentFrameOnly = navigation.pendingHref === null && published.leafKey !== committedFrame.leafKey
    const target = normalizeCommunityHref(navigation.pendingHref
      ?? (currentFrameOnly ? committedFrame.href : navigation.publishedHref))
    const eligible = breakpoint !== "mobile" || resolveCommunityModulePlan(target.href).surface === "list"
    const externalDetail = !fromUserBar && breakpoint === "mobile"
      && (committedFrame.surface === "detail" || checkpoint.surface === "detail")
    if (eligible && !externalDetail) {
      if (navigation.pendingHref !== null
        || !isPublishedNonStructuralCommit(committedFrame, navigation.publishedHref, target.href)) {
        setInboxOpenRequest({
          viewerId: currentUser.id,
          href: target.href,
          currentFrameOnly,
          isCurrent: navigation.pendingHref !== null
            ? navigation.captureIntent({ pendingCommitHref: target.href })
            : navigation.captureIntent(),
        })
        return
      }
      applyInboxOpenChange(true)
      return
    }
    const request = {
      viewerId: currentUser.id,
      href: "/c/me",
      isCurrent: navigation.captureIntent({ nextCommitHref: "/c/me" }),
    }
    navigation.push("/c/me")
    setInboxOpenRequest(request)
  }, [applyInboxOpenChange, breakpoint, checkpoint.surface, committedFrame, currentUser.id, navigation, setInboxOpenRequest])
  const openInbox = useCallback(() => requestInboxOpen(false), [requestInboxOpen])
  const onUserBarInboxOpenChange = useCallback((open: boolean) => {
    if (open) {
      requestInboxOpen(true)
      return
    }
    setInboxOpenRequest(null)
    applyInboxOpenChange(false)
  }, [applyInboxOpenChange, requestInboxOpen, setInboxOpenRequest])
  useEffect(() => {
    if (!inboxOpenRequest) return
    if (inboxOpenRequest.viewerId !== currentUser.id || !inboxOpenRequest.isCurrent()) {
      setInboxOpenRequest(null)
      return
    }
    const published = normalizeCommunityHref(navigation.publishedHref)
    const target = normalizeCommunityHref(inboxOpenRequest.href)
    const publicationMatches = inboxOpenRequest.currentFrameOnly
      ? committedFrame.leafKey === target.leafKey && published.leafKey === target.leafKey
      : isPublishedNonStructuralCommit(committedFrame, navigation.publishedHref, target.href)
    if (navigation.navigationPending || navigation.pendingHref !== null
      || !publicationMatches
      || (breakpoint === "mobile" && checkpoint.surface !== "list")) return
    setInboxOpenRequest(null)
    applyInboxOpenChange(true)
  }, [applyInboxOpenChange, breakpoint, checkpoint.surface, committedFrame, currentUser.id, inboxOpenRequest,
    navigation.navigationPending, navigation.pendingHref, navigation.publishedHref, setInboxOpenRequest])
  useNativeSystemNotifications(currentUser.id, committedFrame, navigation, notificationConsumer)
  const onUserBarOpenProfile = useCallback<ReturnType<typeof useShellProfileController>["openProfile"]>((
    name,
    event,
    discriminator,
    targetUserId,
  ) => {
    setInboxOpenRequest(null)
    if (userBarExtension.active === "profile") {
      profile.closeProfile()
      dispatchUserBarExtension({ type: "extension.close", extension: "profile" })
      return
    }
    if (userBarExtension.active === "inbox") inbox.onOpenChange(false)
    if (userBarExtension.active === "update") daemonUpdate.collapse()
    profile.openProfile(name, event, discriminator, targetUserId)
    dispatchUserBarExtension({ type: "extension.open", extension: "profile" })
  }, [daemonUpdate, dispatchUserBarExtension, inbox, profile, setInboxOpenRequest, userBarExtension.active])
  const onUserBarOpenUpdate = useCallback(() => {
    setInboxOpenRequest(null)
    if (userBarExtension.active === "inbox") inbox.onOpenChange(false)
    if (userBarExtension.active === "profile") profile.closeProfile()
    daemonUpdate.open()
  }, [daemonUpdate, inbox, profile, setInboxOpenRequest, userBarExtension.active])
  const dismissUserBarExtension = useCallback(() => {
    setInboxOpenRequest(null)
    if (userBarExtension.active === "inbox") inbox.onOpenChange(false)
    if (userBarExtension.active === "profile") profile.closeProfile()
    if (userBarExtension.active === "update") daemonUpdate.collapse()
    dispatchUserBarExtension({
      type: "extension.close",
      extension: userBarExtension.active,
    })
  }, [daemonUpdate, dispatchUserBarExtension, inbox, profile, setInboxOpenRequest, userBarExtension.active])
  useEffect(() => {
    if (breakpoint !== "mobile" || checkpoint.surface !== "detail" || userBarExtension.active === "none") return
    dismissUserBarExtension()
  }, [breakpoint, checkpoint.surface, dismissUserBarExtension, userBarExtension.active])
  const dismissNativeBackShellOverlay = useCallback(() => {
    if (navigation.navigationPending) {
      replacePath(committedFrame.href)
      return true
    }
    if (breakpoint === "mobile" && checkpoint.surface === "detail") return false
    if (userBarExtension.active === "none") return false
    dismissUserBarExtension()
    return true
  }, [breakpoint, checkpoint.surface, committedFrame.href, dismissUserBarExtension, navigation.navigationPending, replacePath, userBarExtension.active])
  const pageBack = useRef<MobilePageBack | null>(null)
  const pageBackRegistry = useMemo(() => ({ register: (request: MobilePageBack) => {
    pageBack.current = request
    return () => { if (pageBack.current === request) pageBack.current = null }
  } }), [])
  const goBackMobile = useCallback((target = mobileParentPath) => {
    if (!target) return
    if (breakpoint === "mobile") {
      if (requestNativeBack(document) !== "none" || dismissNativeBackShellOverlay()) return
      if (pageBack.current?.(target)) return
      navigation.replace(target, { resume: true })
    } else navigation.replace(target)
  }, [breakpoint, dismissNativeBackShellOverlay, mobileParentPath, navigation])

  useNativeMobileBack({
    dismissShellOverlay: dismissNativeBackShellOverlay,
    parentPath: mobileParentPath,
    replacePath: goBackMobile,
  })

  useEffect(() => {
    if (userBarExtension.active === "inbox" && !inbox.open) {
      dispatchUserBarExtension({ type: "extension.close", extension: "inbox" })
    }
  }, [dispatchUserBarExtension, inbox.open, userBarExtension.active])

  useEffect(() => {
    if (userBarExtension.active !== "profile") return
    if (profile.profile?.data.userId === currentUser.id) return
    dispatchUserBarExtension({ type: "extension.close", extension: "profile" })
  }, [currentUser.id, dispatchUserBarExtension, profile.profile, userBarExtension.active])

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
    getCommunityRuntime(queryClient).ui.actions.registerUiHandlers({
      previewImage: profile.previewImage,
      previewAttachment: profile.previewAttachment,
      openProfile: profile.openProfile,
      goBackMobile,
      navigatePath: navigation.push,
      replacePath: navigation.replace,
      navigate: rail.navigate,
      cancelPendingNavigation: navigation.cancelPendingNavigation,
    })
  }, [goBackMobile, profile.openProfile, profile.previewAttachment, profile.previewImage, rail.navigate, navigation.cancelPendingNavigation, navigation.push, navigation.replace, queryClient])

  return (
    <CommunityRouteContext value={{ breakpoint, frame: committedFrame, navigation, ownerDeleteRouteScope, openInbox, notificationConsumer }}>
    <MobilePageBackContext value={pageBackRegistry}>
    <ShellFrameView
      breakpoint={breakpoint}
      checkpoint={checkpoint}
      routeCommitted={isPublishedNonStructuralCommit(committedFrame, navigation.publishedHref, navigation.pendingHref ?? navigation.publishedHref)}
      sidebar={sidebar}
      extraDialogs={extraDialogs}
      rail={rail}
      profile={profile}
      inbox={inbox}
      inboxOpening={inboxOpenRequest !== null}
      userBarExtension={userBarExtension}
      daemonUpdate={daemonUpdate}
      onUserBarInboxOpenChange={onUserBarInboxOpenChange}
      onUserBarOpenProfile={onUserBarOpenProfile}
      onUserBarOpenUpdate={onUserBarOpenUpdate}
      dismissUserBarExtension={dismissUserBarExtension}
    >
      {children}
    </ShellFrameView>
    </MobilePageBackContext>
    </CommunityRouteContext>
  )
}
