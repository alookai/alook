"use client"
import { useAtom, useCreateAtom, useSelector } from "@tanstack/react-store";
import { getCommunityRuntime } from "@/stores/community/runtime"


import { useCallback, useEffect, useMemo, useRef } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { markSwitch } from "@/lib/perf/switch-mark"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useCommunityRouteFrame } from "./community-route-context"
import {
  channelHref,
  communityServerId,
  serverModalMarkerCleanupHref,
  resolveCommunityModulePlan,
} from "@/lib/community/community-route"
import { useBreakpoint } from "@/hooks/use-mobile"
import { ChannelSidebarRevealBoundary } from "@/components/community/channels/channel-sidebar-tree-owner"
import { ServerSettings } from "@/components/community/settings/server-settings"
import { ImageCropDialog } from "@/components/community/image-crop-dialog"
import { validateIconSourceFile } from "@/lib/community/image-crop"
import type { SettingsSection } from "@/components/community/settings/settings-types"
import { canManageServer, isForum, notifLevelDisplay, type ChannelType } from "@alook/shared"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { useCurrentChannelId, useCurrentChannelMeta } from "@/stores/community"
import { useCurrentUser } from "@/contexts/community/current-user"
import {
  useServer,
  useServers,
  serverProjectedQueryFn,
} from "@/hooks/community/use-servers"
import { useServerMembers } from "@/hooks/community/use-server-members"
import {
  claimOwnerServerDeleteNavigation,
  consumeVoluntaryLeave,
  isOwnerServerDeleteRouteProtected,
  runAuthoritativeServerEject,
} from "@/lib/community/eject-server"
import {
  clearLastChannel,
  getLastChannel,
  pickServerLandingHref,
} from "@/lib/community/last-channel"
import { communityKeys } from "@/lib/query-keys"
import { usePresence } from "@/hooks/community/use-server-panels"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import {
  resolveForumSidebarRouteCandidate,
  useForumSidebarThreads,
  type ForumSidebarThread,
} from "@/hooks/community/use-forum-sidebar-threads"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  resolveServerNotificationDisplayLevel,
  useNotificationSettings,
} from "@/hooks/community/use-notification-settings"
import {
  useCreateChannel,
  useRenameChannel,
  useDeleteChannel,
  useMoveChannel,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
  useReorderCategories,
  useReorderChannels,
  useDeleteServer,
  useUpdateServer,
  useUploadServerIcon,
  useSetServerNotifLevel,
  useSetMemberRole,
  useKickMember,
  useRevokeInvite,
} from "@/hooks/community/mutations"
import {
  useCanonicalProfilesByUserId,
  useOptionalCommunityDbRegistry,
  useTrustedRestoredPrimary,
} from "@/lib/community-db/projections"

export function ServerSidebarSlot({ serverId }: { serverId: string }) {
  const { frame, ownerDeleteRouteScope } = useCommunityRouteFrame()
  if (frame.scope.kind !== "server" || frame.scope.serverId !== serverId
    || ownerDeleteRouteScope?.serverId !== serverId) return null
  return <ServerSidebar key={serverId} serverId={serverId} />
}

function ServerSidebar({ serverId }: { serverId: string }) {
  const { frame, navigation, ownerDeleteRouteScope } = useCommunityRouteFrame()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const modulePlan = resolveCommunityModulePlan(frame.pathname)
  const routeChannelId = modulePlan.main.kind === "server-conversation" ? modulePlan.main.leafId : null
  const queryClient = useQueryClient()
  const ownerDeleteRouteToken = ownerDeleteRouteScope!.token
  const ownerDeleteRouteProtected = useSelector(getCommunityRuntime(queryClient).serverEject, (state) => state.transactions.has(serverId) || state.tombstones.get(ownerDeleteRouteToken) === serverId)
  const hasChannel = !!routeChannelId
  const breakpoint = useBreakpoint()

  const router = useRouter()
  const communityDb = useOptionalCommunityDbRegistry()
  const trustedRestoredPrimary = useTrustedRestoredPrimary()
  const cancelPendingNavigation = useCallback(() => {
    getCommunityRuntime(queryClient).ui.get().uiHandlers.cancelPendingNavigation?.()
  }, [queryClient])
  const currentUser = useCurrentUser()
  const serverAccessRevoked = useCommunityWsStore(
    (state) => state.revokedServerIds.has(serverId),
  )
  const {
    server: currentServer,
    data: authoritativeServer,
  } = useServer(ownerDeleteRouteProtected ? null : serverId)
  const sidebarCategories = useMemo(
    () => currentServer?.categories ?? [],
    [currentServer],
  )
  const sidebarHintOnly = Boolean(currentServer && !authoritativeServer)
  const membersHook = useServerMembers(currentServer ? serverId : null)
  const profilesByUserId = useCanonicalProfilesByUserId()
  const enrichedMembers = useMemo(
    () =>
      membersHook.members.map((m) => {
        const canonical = profilesByUserId.get(m.userId)
        const profile = canonical
          ? readCommunityProfile(canonical, m.userId)
          : { ...m, presence: m.status }
        return {
          ...m,
          name: profile.name,
          discriminator: profile.discriminator,
          avatar: profile.avatar,
          avatarVersion: profile.avatarVersion,
          status: m.userId === currentUser.id ? "online" as const : profile.presence,
          statusEmoji: profile.statusEmoji,
          statusText: profile.statusText,
        }
      }),
    [currentUser.id, membersHook.members, profilesByUserId],
  )
  // `myMember` comes from the raw (not enriched) members list so this stays
  // stable across presence ticks.
  const myMember = membersHook.members.find((m) => m.userId === currentUser.id)
  const isAdmin = canManageServer(myMember?.role)
  usePresence(currentServer ? serverId : null)
  const notifs = useNotificationSettings()
  const notifLevel = resolveServerNotificationDisplayLevel(notifs.server[serverId])
  const channelNotif = notifs.channel
  const currentChannelId = useCurrentChannelId()
  const currentChannelMeta = useCurrentChannelMeta()
  const activeForumThreadId = useMemo(() => {
    if (!currentChannelId || !currentChannelMeta?.parentChannelId) return null
    const parent = sidebarCategories
      .flatMap((category) => category.channels)
      .find((channel) => channel.id === currentChannelMeta.parentChannelId)
    return isForum(parent?.type) ? currentChannelId : null
  }, [currentChannelId, currentChannelMeta?.parentChannelId, sidebarCategories])
  const sidebarRouteCandidate = useMemo(() => {
    const topLevelChannels = sidebarCategories.length > 0
      ? sidebarCategories.flatMap((category) => category.channels)
      : null
    const parent = currentChannelId === routeChannelId && currentChannelMeta?.parentChannelId
      ? topLevelChannels?.find((channel) => channel.id === currentChannelMeta.parentChannelId)
      : null
    return resolveForumSidebarRouteCandidate(
      routeChannelId,
      topLevelChannels?.map((channel) => channel.id) ?? null,
      isForum(parent?.type),
    )
  }, [currentChannelId, currentChannelMeta?.parentChannelId, routeChannelId, sidebarCategories])
  const forumSidebar = useForumSidebarThreads(
    serverId,
    sidebarRouteCandidate,
    !!currentServer?.categories,
  )
  const forumThreadsByParent = useMemo(() => {
    const grouped: Record<string, ForumSidebarThread[]> = {}
    for (const thread of forumSidebar.threads) {
      const siblings = grouped[thread.parentChannelId] ?? []
      siblings.push(thread)
      grouped[thread.parentChannelId] = siblings
    }
    return grouped
  }, [forumSidebar.threads])

  const serversList = useServers()
  const serverDestination = useCallback(async (id: string) => {
    const lastChannel = getLastChannel(id)
    const read = () => communityDb ? Array.from(communityDb.collections.channels.values()).filter((channel) => channel.serverId === id && channel.type !== "thread" && !channel.pending).map((channel) => channel.id) : []
    if (!communityDb?.collections.servers.get(id)?.detailComplete && !lastChannel && read().length === 0) {
      try {
        await queryClient.query({ queryKey: communityKeys.server(id), queryFn: ({ signal }) => serverProjectedQueryFn(queryClient, id, signal)(), staleTime: Infinity, select: undefined })
      } catch {}
    }
    const channelIds = read()
    return pickServerLandingHref(id, channelIds, lastChannel)
  }, [communityDb, queryClient])

  // Mutations
  const createChannelMut = useCreateChannel()
  const renameChannelMut = useRenameChannel()
  const deleteChannelMut = useDeleteChannel()
  const moveChannelMut = useMoveChannel()
  const createCategoryMut = useCreateCategory()
  const updateCategoryMut = useUpdateCategory()
  const deleteCategoryMut = useDeleteCategory()
  const reorderCategoriesMut = useReorderCategories()
  const reorderChannelsMut = useReorderChannels()
  const deleteServerMut = useDeleteServer({
    routeToken: ownerDeleteRouteToken,
    onSuccess: ({ serverId: deletedServerId, isUiCurrent }, { needsNavigation }) => {
      if (isUiCurrent?.()) toast("Server deleted")
      clearLastChannel(deletedServerId)
      if (!needsNavigation) return
      void (async () => {
        const allowed = new Set([...communityDb!.collections.serverMemberships.values()].filter((row) => row.viewer && row.userId === currentUser.id).map((row) => row.serverId))
        const survivor = [...communityDb!.collections.servers.values()].filter((server) => allowed.has(server.id)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).find((server) => server.id !== deletedServerId)
        const destination = survivor
          ? await serverDestination(survivor.id)
          : "/c/me"
        if (!isUiCurrent?.()) return
        if (!claimOwnerServerDeleteNavigation(queryClient,
          deletedServerId,
          ownerDeleteRouteToken,
          destination,
        )) return
        cancelPendingNavigation()
        router.replace(destination)
      })()
    },
    onError: (error, { isUiCurrent }) => { if (isUiCurrent?.()) toastApiError(error, "Failed to delete server", () => { if (!isUiCurrent?.()) throw new DOMException("Retired delete navigation", "AbortError") }) },
  })
  const updateServerMut = useUpdateServer()
  const uploadServerIconMut = useUploadServerIcon()
  const setServerNotifMut = useSetServerNotifLevel()
  const setMemberRoleMut = useSetMemberRole()
  const kickMemberMut = useKickMember()
  const revokeInviteMut = useRevokeInvite()

  // Eject when the URL is scoped to a server the viewer isn't in. Covers
  // four triggers with one effect:
  //   1. Viewer clicked "Leave" (rail button pre-marks the id via
  //      markVoluntaryLeave — we stay silent, the button owns the toast).
  //   2. Viewer was kicked from another tab (WS member.leave invalidates
  //      `servers()` when userId === viewer, list drops the row).
  //   3. Owner deleted the server (WS server.delete invalidates same).
  //   4. Viewer pasted a URL for a server they were never in (list
  //      finishes loading, id is missing from the start).
  //
  // Only a settled SUCCESSFUL snapshot can prove absence. `isFetched` is also
  // true after a first 5xx, while a failed background refetch may retain
  // last-good data; treating either as authoritative ejects valid URLs on a
  // transient read failure. The ref prevents a re-fire during navigation.
  const ejectedRef = useRef(false)
  useEffect(() => {
    if (ejectedRef.current) return
    if (navigation.navigationPending
      && communityServerId(navigation.pendingHref ?? "") !== serverId) return
    if (typeof window !== "undefined"
      && communityServerId(window.location.pathname) !== serverId) return
    ejectedRef.current = runAuthoritativeServerEject({
      serverId,
      servers: serversList.servers,
      // A target-specific 403/404 is already definitive even if revoking the
      // target advanced the access epoch and retired an in-flight list read.
      // A restored list is renderable but its absence is not an access
      // verdict. Only a live list confirmed for this QueryClient + auth
      // generation may drive the generic eject path.
      isSuccess: serverAccessRevoked
        || (serversList.isSuccess && serversList.isLiveAuthoritative),
      isFetching: serverAccessRevoked ? false : serversList.isFetching,
      ownerDeleteRouteProtected: isOwnerServerDeleteRouteProtected(queryClient, serverId),
      consumeVoluntaryLeave: (id) => consumeVoluntaryLeave(queryClient, id),
      clearLastChannel,
      toast,
      accountId: currentUser.id,
      routeHref: pathname,
      replace: (destination) => {
        cancelPendingNavigation()
        router.replace(destination)
      },
    })
  }, [cancelPendingNavigation, currentUser.id, navigation.navigationPending, navigation.pendingHref, pathname, serverAccessRevoked, serverId, serversList.isLiveAuthoritative, serversList.isSuccess, serversList.isFetching, serversList.servers, router, searchParams, queryClient])
  // Reset the guard when the URL changes to a NEW server id — otherwise
  // navigating server → dangling-server → server would leave the ref
  // latched and skip the eject.
  useEffect(() => {
    ejectedRef.current = false
  }, [serverId])

  const [serverSettingsOpen, setServerSettingsOpen] = useAtom(useCreateAtom(false))
  const settingsView = useCommunityViewSource("server-settings:" + serverId, serverSettingsOpen)
  const [settingsSection, setSettingsSection] = useAtom(useCreateAtom<SettingsSection>("overview"))
  const [invitePopoverOpen, setInvitePopoverOpen] = useAtom(useCreateAtom(false))
  const [pendingIconCrop, setPendingIconCrop] = useAtom(useCreateAtom<{ src: string; fileName: string } | null>(null))

  // Close server-scoped dialogs when the user navigates to another server —
  // without this, settings for server A would remain open after switching
  // to server B, mixing A's draft with B's loaded metadata.
  useEffect(() => {
    setServerSettingsOpen(false)
    setSettingsSection("overview")
    setInvitePopoverOpen(false)
  }, [serverId, setInvitePopoverOpen, setServerSettingsOpen, setSettingsSection])

  // Open the dialog the instant we see the flag — this only touches local
  // state, so it can't race with the sibling default-channel page's own
  // redirect below. (Splitting this from the URL cleanup fixes a bug where
  // waiting to open the dialog until *after* the redirect meant the flag —
  // and the URL query string carrying it — was already gone by then, so the
  // dialog silently never opened.)
  useEffect(() => {
    if (communityServerId(pathname) !== serverId) return
    if (searchParams.get("settings") === "1") setServerSettingsOpen(true)
    if (searchParams.get("invite") === "1") setInvitePopoverOpen(true)
  }, [pathname, serverId, searchParams, setInvitePopoverOpen, setServerSettingsOpen])

  useEffect(() => {
    // These flags land on the bare `/c/channels/:serverId` URL
    // (e.g. right-click a rail server → "Server settings"/"Invite to
    // Server"), which is also the URL the sibling default-channel page
    // redirects away from once it knows the server's first channel on
    // desktop. With a warm detail query, the child and parent effects can
    // replace in the same commit, so desktop waits until the channel route
    // wins. Mobile intentionally remains on the server root and must consume
    // the one-shot marker there instead of waiting for a redirect that never
    // runs.
    if (ownerDeleteRouteProtected || communityServerId(pathname) !== serverId) return
    const search = searchParams.toString()
    const currentHref = `${pathname}${search ? `?${search}` : ""}`
    const cleanupHref = serverModalMarkerCleanupHref(currentHref, {
      breakpoint,
      hasChannel,
      hasServerChannels: Boolean(
        currentServer?.categories.some((category) => category.channels.length > 0),
      ),
    })
    if (!cleanupHref) return

    cancelPendingNavigation()
    router.replace(cleanupHref)
  }, [
    breakpoint,
    serverId,
    cancelPendingNavigation,
    searchParams,
    pathname,
    router,
    hasChannel,
    currentServer,
    ownerDeleteRouteProtected,
  ])

  const categories = useMemo(() => sidebarCategories.map((category) => ({
    ...category,
    channels: category.channels.map((channel) =>
      forumSidebar.parentUnread[channel.id] === undefined
        ? channel
        : { ...channel, unread: forumSidebar.parentUnread[channel.id] },
    ),
  })), [forumSidebar.parentUnread, sidebarCategories])
  const sidebarDataReady = Boolean(currentServer)
  const channelTreeScopeKey = `server:${serverId}`

  const setActiveChannel = useCallback((id: string) => {
    // Only navigate — do NOT eagerly set the store's currentChannelId here.
    // The currently-mounted ChannelView is still keyed to the old channelId;
    // flipping the store now triggers its reset effect (messagesLoading=true)
    // while the URL still points at the OLD channel, so the loading skeleton
    // renders using the old channel's type for one frame. Letting the newly-
    // mounted ChannelView sync the store in its own useEffect keeps skeleton
    // type consistent with the target channel.
    //
    // The visible-row observer is the only optimistic/read writer. Navigation
    // itself must leave account unread state untouched.
    markSwitch("channel", id)
    cancelPendingNavigation()
    getCommunityRuntime(queryClient).ui.get().uiHandlers.navigatePath?.(channelHref(serverId, id))
  }, [cancelPendingNavigation, queryClient, serverId])

  const setActiveForumThread = useCallback((_parentId: string, id: string) => {
    markSwitch("channel", id)
    cancelPendingNavigation()
    getCommunityRuntime(queryClient).ui.get().uiHandlers.navigatePath?.(
      channelHref(serverId, id),
    )
  }, [cancelPendingNavigation, queryClient, serverId])

  const onSidebarOpenSettings = useCallback((section?: SettingsSection) => {
    if (section) setSettingsSection(section)
    setServerSettingsOpen(true)
  }, [setServerSettingsOpen, setSettingsSection])


  const onBlockedCreate = useCallback(() => {
    toast("Only admins can create channels in a private category")
  }, [])

  const mutedChannels = useMemo(
    () => Object.fromEntries(
      Object.entries(channelNotif).map(([k, v]) => [k, v === notifLevelDisplay("nothing")])
    ),
    [channelNotif]
  )

  const onCreateChannelInSidebar = useCallback(async (categoryId: string, name: string, type: ChannelType) => {
    try {
      const res = await createChannelMut.mutateAsync({ serverId, categoryId, name, type })
      return res.channel.id
    } catch (e) {
      toastApiError(e, "Failed to create channel")
      return null
    }
  }, [createChannelMut, serverId])
  const onCreateCategoryInSidebar = useCallback((name: string, opts?: { private?: boolean }) => {
    createCategoryMut.mutate(
      { serverId, name, private: opts?.private },
      { onError: (e) => toastApiError(e, "Failed to create category") },
    )
  }, [createCategoryMut, serverId])
  const onRenameChannel = useCallback((channelId: string, name: string) => {
    renameChannelMut.mutate(
      { serverId, channelId, name },
      { onError: (e) => toastApiError(e, "Failed to rename channel") },
    )
  }, [renameChannelMut, serverId])
  const onDeleteChannelInSidebar = useCallback((channelId: string) => {
    deleteChannelMut.mutate({ serverId, channelId }, { onError: (e) => toastApiError(e, "Failed to delete channel") })
  }, [deleteChannelMut, serverId])
  const onDeleteCategoryInSidebar = useCallback((categoryId: string) => {
    deleteCategoryMut.mutate({ serverId, categoryId }, { onError: (e) => toastApiError(e, "Failed to delete category") })
  }, [deleteCategoryMut, serverId])
  const onUpdateCategoryInSidebar = useCallback((categoryId: string, opts: { name?: string }) => {
    updateCategoryMut.mutate({ serverId, categoryId, name: opts.name }, { onError: (e) => toastApiError(e, "Failed to update category") })
  }, [updateCategoryMut, serverId])
  const onReorderCategoriesInSidebar = useCallback((categoryIds: string[]) => {
    reorderCategoriesMut.mutate({ serverId, categoryIds }, { onError: (e) => toastApiError(e, "Failed to save category order") })
  }, [reorderCategoriesMut, serverId])
  const onReorderChannelsInSidebar = useCallback((channelIds: string[]) => {
    reorderChannelsMut.mutate({ serverId, channelIds }, { onError: (e) => toastApiError(e, "Failed to save channel order") })
  }, [reorderChannelsMut, serverId])
  const onMoveChannelInSidebar = useCallback((channelId: string, categoryId: string | null) => {
    moveChannelMut.mutate({ serverId, channelId, categoryId }, { onError: (e) => toastApiError(e, "Failed to move channel") })
  }, [moveChannelMut, serverId])
  const onBlockedMove = useCallback(() => {
    toast("Can't move a channel between public and private categories")
  }, [])

  const channelProps = useMemo(() => ({
    serverName: currentServer?.name ?? "",
    serverIcon: currentServer?.icon ?? null,
    official: currentServer?.official ?? false,
    activeChannel: currentChannelMeta?.parentChannelId ?? currentChannelId ?? "",
    isAdmin,
    currentUserId: currentUser.id,
    setActiveChannel,
    forumThreadsByParent,
    activeThreadId: activeForumThreadId,
    onSelectForumThread: setActiveForumThread,
    onOpenSettings: !sidebarHintOnly && isAdmin ? onSidebarOpenSettings : undefined,
    onBlockedCreate,
    mutedChannels,
    onCreateChannel: sidebarHintOnly ? undefined : onCreateChannelInSidebar,
    onCreateCategory: sidebarHintOnly ? undefined : onCreateCategoryInSidebar,
    onRenameChannel: sidebarHintOnly ? undefined : onRenameChannel,
    onDeleteChannel: sidebarHintOnly ? undefined : onDeleteChannelInSidebar,
    onDeleteCategory: sidebarHintOnly ? undefined : onDeleteCategoryInSidebar,
    onUpdateCategory: sidebarHintOnly ? undefined : onUpdateCategoryInSidebar,
    onReorderCategories: sidebarHintOnly ? undefined : onReorderCategoriesInSidebar,
    onReorderChannels: sidebarHintOnly ? undefined : onReorderChannelsInSidebar,
    onMoveChannel: sidebarHintOnly ? undefined : onMoveChannelInSidebar,
    onBlockedMove,
    serverId,
    invitePopoverOpen,
    onInvitePopoverOpenChange: sidebarHintOnly ? undefined : setInvitePopoverOpen,
  }), [currentServer?.name, currentServer?.icon, currentServer?.official, currentChannelMeta?.parentChannelId, currentChannelId, isAdmin, currentUser.id, setActiveChannel, forumThreadsByParent, activeForumThreadId, setActiveForumThread, sidebarHintOnly, onSidebarOpenSettings, onBlockedCreate, mutedChannels, onCreateChannelInSidebar, onCreateCategoryInSidebar, onRenameChannel, onDeleteChannelInSidebar, onDeleteCategoryInSidebar, onUpdateCategoryInSidebar, onReorderCategoriesInSidebar, onReorderChannelsInSidebar, onMoveChannelInSidebar, onBlockedMove, serverId, invitePopoverOpen, setInvitePopoverOpen])

  const openProfile = (name: string, e: React.MouseEvent, discriminator?: string, userId?: string) => {
    // Delegate to the shell's registered openProfile via the community store.
    getCommunityRuntime(queryClient).ui.get().uiHandlers.openProfile?.(name, e, discriminator, userId)
  }

  const closeSettings = () => { settingsView.retire(); setServerSettingsOpen(false); setSettingsSection("overview") }

  const sidebar = useCallback((opts: { noHeader?: boolean } = {}) => (
    <ChannelSidebarRevealBoundary
      key={channelTreeScopeKey}
      scopeKey={channelTreeScopeKey}
      categories={categories}
      primaryReady={sidebarDataReady}
      forumProjectionMissing={!forumSidebar.projectionReady}
      trustedRestoredPrimary={trustedRestoredPrimary}
      targetServerId={serverId}
      {...channelProps}
      {...opts}
    />
  ), [
    categories,
    channelProps,
    channelTreeScopeKey,
    forumSidebar.projectionReady,
    serverId,
    sidebarDataReady,
    trustedRestoredPrimary,
  ])

  const serverSettingsDialog = (
    <Dialog open={serverSettingsOpen && !!currentServer && isAdmin} onOpenChange={(o) => { if (!o) closeSettings() }}>
      <DialogContent className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[calc(100vh-4rem)] sm:max-h-180 sm:w-[calc(100vw-4rem)] sm:max-w-4xl sm:rounded-xl" showCloseButton={false}>
        <ServerSettings
          isAdmin={isAdmin}
          section={settingsSection}
          setSection={setSettingsSection}
          onClose={closeSettings}
          serverId={serverId}
          serverName={currentServer?.name ?? ""}
          serverDescription={currentServer?.description ?? ""}
          serverIcon={currentServer?.icon ?? null}
          members={enrichedMembers}
          membersLoading={membersHook.loading}
          membersLoadingMore={membersHook.loadingMore}
          membersHasMore={membersHook.hasMore}
          membersTotal={membersHook.total}
          onLoadMoreMembers={membersHook.loadMore}
          onSearchMembers={membersHook.searchMembers}
          onKickMember={(memberId) => {
            const assert = settingsView.capture()
            kickMemberMut.mutate({ serverId, memberId, assertActive: assert }, {
              onSuccess: () => { try { assert(); toast("Member kicked") } catch {} },
              onError: (e) => toastApiError(e, "Failed to kick member", assert),
            })
          }}
          onSetRole={(memberId, role) => {
            const assert = settingsView.capture()
            setMemberRoleMut.mutate({ serverId, memberId, role, assertActive: assert }, {
              onSuccess: () => { try { assert(); toast("Role updated") } catch {} },
              onError: (e) => toastApiError(e, "Failed to update role", assert),
            })
          }}
          onRevokeInvite={(code) => {
            const assert = settingsView.capture()
            revokeInviteMut.mutate({ serverId, code, assertActive: assert }, {
              onSuccess: () => { try { assert(); toast("Invite revoked") } catch {} },
              onError: (e) => toastApiError(e, "Failed to revoke invite", assert),
            })
          }}
          onCopyInvite={(code) => {
            const assert = settingsView.capture()
            assert()
            void navigator.clipboard.writeText(`${window.location.origin}/c/invite/${code}`).then(() => { try { assert(); toast("Invite copied") } catch {} }, (error) => toastApiError(error, "Couldn't copy invite", assert))
          }}
          onDeleteServer={async () => {
            closeSettings()
            deleteServerMut.mutate({ serverId, isUiCurrent: navigation.captureIntent() })
          }}
          onUploadIcon={() => {
            const input = document.createElement("input")
            input.type = "file"
            input.accept = "image/png,image/jpeg,image/webp"
            input.onchange = () => {
              const f = input.files?.[0]
              if (!f) return
              const check = validateIconSourceFile(f)
              if (!check.ok) {
                toast(check.error)
                return
              }
              setPendingIconCrop({ src: URL.createObjectURL(f), fileName: f.name })
            }
            input.click()
          }}
          onUpdateServer={(name, desc) =>
            updateServerMut.mutate({ serverId, name, description: desc }, {
              onSuccess: () => toast("Server updated"),
              onError: (e) => toastApiError(e, "Failed to update server"),
            })
          }
          notifLevel={notifLevel}
          onSetNotifLevel={(level) => setServerNotifMut.mutate({ serverId, level }, {
            onError: (e) => toastApiError(e, "Failed to update notification level"),
          })}
          onOpenProfile={openProfile}
        />
      </DialogContent>
    </Dialog>
  )

  const iconCropDialog = pendingIconCrop && (
    <ImageCropDialog
      imageSrc={pendingIconCrop.src}
      originalFileName={pendingIconCrop.fileName}
      maskShape="square"
      onCropped={(file) => {
        uploadServerIconMut.mutate({ serverId, file }, {
          onSuccess: () => toast("Server icon updated"),
          onError: (e) => toastApiError(e, "Failed to upload icon"),
        })
        URL.revokeObjectURL(pendingIconCrop.src)
        setPendingIconCrop(null)
      }}
      onCancel={() => {
        URL.revokeObjectURL(pendingIconCrop.src)
        setPendingIconCrop(null)
      }}
    />
  )

  return <>{sidebar()}{serverSettingsDialog}{iconCropDialog}</>
}
