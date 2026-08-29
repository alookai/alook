"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { markSwitch } from "@/lib/perf/switch-mark"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useChannelTree } from "@/components/community/channels/use-channel-tree"
import { ShellFrame } from "@/components/community/shell/shell-frame"
import {
  channelHref,
  serverModalMarkerCleanupHref,
  serverRootHref,
} from "@/lib/community/community-route"
import { useBreakpoint } from "@/hooks/use-mobile"
import { ChannelSidebar } from "@/components/community/channels/channel-sidebar"
import { ChannelRoute } from "@/components/community/channels/channel-route"
import { ServerSettings } from "@/components/community/settings/server-settings"
import { ImageCropDialog } from "@/components/community/image-crop-dialog"
import { validateIconSourceFile } from "@/lib/community/image-crop"
import type { SettingsSection } from "@/components/community/settings/settings-types"
import { canManageServer, isForum, notifLevelDisplay, type ChannelType } from "@alook/shared"
import { readCommunityProfile } from "@/lib/community/profile-read"
import {
  useCommunityStore,
  useCurrentChannelId,
  useCurrentChannelMeta,
} from "@/stores/community"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useServer, useServers } from "@/hooks/community/use-servers"
import { useServerMembers } from "@/hooks/community/use-server-members"
import {
  consumeVoluntaryLeave,
  runAuthoritativeServerEject,
} from "@/lib/community/eject-server"
import { clearLastChannel } from "@/lib/community/last-channel"
import { usePresence } from "@/hooks/community/use-server-panels"
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

export default function ServerLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ serverId: string; channelId?: string }>()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const serverId = decodeURIComponent(params.serverId)
  const routeChannelId = params.channelId ? decodeURIComponent(params.channelId) : null
  const hasChannel = !!routeChannelId
  const breakpoint = useBreakpoint()

  const router = useRouter()
  const cancelPendingNavigation = useCallback(() => {
    useCommunityStore.getState().uiHandlers.cancelPendingNavigation?.()
  }, [])
  const currentUser = useCurrentUser()
  const { server: currentServer } = useServer(serverId)
  const membersHook = useServerMembers(serverId)
  const profilesByUserId = useCommunityWsStore((s) => s.profilesByUserId)
  const enrichedMembers = useMemo(
    () =>
      membersHook.members.map((m) => {
        const profile = readCommunityProfile(profilesByUserId.get(m.userId), m.userId)
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
  usePresence(serverId)
  const notifs = useNotificationSettings()
  const notifLevel = resolveServerNotificationDisplayLevel(notifs.server[serverId])
  const channelNotif = notifs.channel
  const currentChannelId = useCurrentChannelId()
  const currentChannelMeta = useCurrentChannelMeta()
  const activeForumThreadId = useMemo(() => {
    if (!currentChannelId || !currentChannelMeta?.parentChannelId) return null
    const parent = currentServer?.categories
      .flatMap((category) => category.channels)
      .find((channel) => channel.id === currentChannelMeta.parentChannelId)
    return isForum(parent?.type) ? currentChannelId : null
  }, [currentChannelId, currentChannelMeta?.parentChannelId, currentServer])
  const sidebarRouteCandidate = useMemo(() => {
    const topLevelChannels = currentServer?.categories
      ?.flatMap((category) => category.channels) ?? null
    const parent = currentChannelId === routeChannelId && currentChannelMeta?.parentChannelId
      ? topLevelChannels?.find((channel) => channel.id === currentChannelMeta.parentChannelId)
      : null
    return resolveForumSidebarRouteCandidate(
      routeChannelId,
      topLevelChannels?.map((channel) => channel.id) ?? null,
      isForum(parent?.type),
    )
  }, [currentChannelId, currentChannelMeta?.parentChannelId, currentServer, routeChannelId])
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
  const deleteServerMut = useDeleteServer()
  const updateServerMut = useUpdateServer()
  const uploadServerIconMut = useUploadServerIcon()
  const setServerNotifMut = useSetServerNotifLevel()
  const setMemberRoleMut = useSetMemberRole()
  const kickMemberMut = useKickMember()
  const revokeInviteMut = useRevokeInvite()

  useEffect(() => {
    useCommunityStore.getState().setCurrentServerId(serverId)
  }, [serverId])

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
  const serversList = useServers()
  const ejectedRef = useRef(false)
  useEffect(() => {
    if (ejectedRef.current) return
    ejectedRef.current = runAuthoritativeServerEject({
      serverId,
      servers: serversList.servers,
      isSuccess: serversList.isSuccess,
      isFetching: serversList.isFetching,
      consumeVoluntaryLeave,
      clearLastChannel,
      toast,
      replace: (destination) => {
        cancelPendingNavigation()
        router.replace(destination)
      },
    })
  }, [cancelPendingNavigation, serverId, serversList.isSuccess, serversList.isFetching, serversList.servers, router, searchParams])
  // Reset the guard when the URL changes to a NEW server id — otherwise
  // navigating server → dangling-server → server would leave the ref
  // latched and skip the eject.
  useEffect(() => {
    ejectedRef.current = false
  }, [serverId])

  const [serverSettingsOpen, setServerSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("overview")
  const [invitePopoverOpen, setInvitePopoverOpen] = useState(false)
  const [pendingIconCrop, setPendingIconCrop] = useState<{ src: string; fileName: string } | null>(null)

  // Close server-scoped dialogs when the user navigates to another server —
  // without this, settings for server A would remain open after switching
  // to server B, mixing A's draft with B's loaded metadata.
  useEffect(() => {
    setServerSettingsOpen(false)
    setSettingsSection("overview")
    setInvitePopoverOpen(false)
  }, [serverId])

  // Open the dialog the instant we see the flag — this only touches local
  // state, so it can't race with the sibling default-channel page's own
  // redirect below. (Splitting this from the URL cleanup fixes a bug where
  // waiting to open the dialog until *after* the redirect meant the flag —
  // and the URL query string carrying it — was already gone by then, so the
  // dialog silently never opened.)
  useEffect(() => {
    if (searchParams.get("settings") === "1") setServerSettingsOpen(true)
    if (searchParams.get("invite") === "1") setInvitePopoverOpen(true)
  }, [searchParams])

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
    cancelPendingNavigation,
    searchParams,
    pathname,
    router,
    hasChannel,
    currentServer,
  ])

  const categories = useMemo(() => (currentServer?.categories ?? []).map((category) => ({
    ...category,
    channels: category.channels.map((channel) =>
      forumSidebar.parentUnread[channel.id] === undefined
        ? channel
        : { ...channel, unread: forumSidebar.parentUnread[channel.id] },
    ),
  })), [currentServer?.categories, forumSidebar.parentUnread])
  const channelTree = useChannelTree(categories)

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
    useCommunityStore.getState().uiHandlers.navigatePath?.(channelHref(serverId, id))
  }, [cancelPendingNavigation, serverId])

  const setActiveForumThread = useCallback((_parentId: string, id: string) => {
    markSwitch("channel", id)
    cancelPendingNavigation()
    useCommunityStore.getState().uiHandlers.navigatePath?.(
      channelHref(serverId, id),
    )
  }, [cancelPendingNavigation, serverId])

  const prefetchChannel = useCallback(
    (id: string, _parentId?: string) => router.prefetch(channelHref(serverId, id)),
    [router, serverId],
  )

  const onSidebarOpenSettings = useCallback((section?: SettingsSection) => {
    if (section) setSettingsSection(section)
    setServerSettingsOpen(true)
  }, [])

  const onRailOpenActiveInvite = useCallback(() => {
    setInvitePopoverOpen(true)
  }, [])

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
    tree: channelTree,
    serverName: currentServer?.name ?? "",
    serverIcon: currentServer?.icon ?? null,
    activeChannel: currentChannelMeta?.parentChannelId ?? currentChannelId ?? "",
    isAdmin,
    currentUserId: currentUser.id,
    loading: !currentServer,
    setActiveChannel,
    prefetchChannel,
    forumThreadsByParent,
    activeThreadId: activeForumThreadId,
    onSelectForumThread: setActiveForumThread,
    onOpenSettings: isAdmin ? onSidebarOpenSettings : undefined,
    onBlockedCreate,
    mutedChannels,
    onCreateChannel: onCreateChannelInSidebar,
    onCreateCategory: onCreateCategoryInSidebar,
    onRenameChannel,
    onDeleteChannel: onDeleteChannelInSidebar,
    onDeleteCategory: onDeleteCategoryInSidebar,
    onUpdateCategory: onUpdateCategoryInSidebar,
    onReorderCategories: onReorderCategoriesInSidebar,
    onReorderChannels: onReorderChannelsInSidebar,
    onMoveChannel: onMoveChannelInSidebar,
    onBlockedMove,
    serverId,
    invitePopoverOpen,
    onInvitePopoverOpenChange: setInvitePopoverOpen,
  }), [
    channelTree, currentServer, currentChannelMeta?.parentChannelId,
    currentChannelId, isAdmin, currentUser.id, setActiveChannel, prefetchChannel,
    forumThreadsByParent, activeForumThreadId, setActiveForumThread,
    onSidebarOpenSettings, onBlockedCreate, mutedChannels,
    onCreateChannelInSidebar, onCreateCategoryInSidebar, onRenameChannel,
    onDeleteChannelInSidebar, onDeleteCategoryInSidebar, onUpdateCategoryInSidebar,
    onReorderCategoriesInSidebar, onReorderChannelsInSidebar,
    onMoveChannelInSidebar, onBlockedMove,
    serverId, invitePopoverOpen,
  ])

  const openProfile = (name: string, e: React.MouseEvent, discriminator?: string, userId?: string) => {
    // Delegate to the shell's registered openProfile via the community store.
    useCommunityStore.getState().uiHandlers.openProfile?.(name, e, discriminator, userId)
  }

  const closeSettings = () => { setServerSettingsOpen(false); setSettingsSection("overview") }

  const sidebar = useCallback((opts: { noHeader?: boolean } = {}) => (
    <ChannelSidebar {...channelProps} {...opts} />
  ), [channelProps])

  const serverSettingsDialog = (
    <Dialog open={serverSettingsOpen} onOpenChange={(o) => { if (!o) closeSettings() }}>
      <DialogContent className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[calc(100vh-4rem)] sm:max-h-180 sm:w-[calc(100vw-4rem)] sm:max-w-4xl sm:rounded-xl" showCloseButton={false}>
        <ServerSettings
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
            kickMemberMut.mutate({ serverId, memberId }, {
              onSuccess: () => toast("Member kicked"),
              onError: (e) => toastApiError(e, "Failed to kick member"),
            })
          }}
          onSetRole={(memberId, role) => {
            setMemberRoleMut.mutate({ serverId, memberId, role }, {
              onSuccess: () => toast("Role updated"),
              onError: (e) => toastApiError(e, "Failed to update role"),
            })
          }}
          onRevokeInvite={(code) => revokeInviteMut.mutate({ serverId, code }, {
            onSuccess: () => toast("Invite revoked"),
            onError: (e) => toastApiError(e, "Failed to revoke invite"),
          })}
          onCopyInvite={(code) => { navigator.clipboard?.writeText(`${window.location.origin}/c/invite/${code}`); toast("Invite copied") }}
          onDeleteServer={async () => {
            closeSettings()
            deleteServerMut.mutate({ serverId }, {
              onSuccess: () => {
                toast("Server deleted")
                useCommunityStore.getState().setCurrentServerId(null)
                cancelPendingNavigation()
                useCommunityStore.getState().uiHandlers.navigatePath?.("/c/me")
              },
              onError: (e) => toastApiError(e, "Failed to delete server"),
            })
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

  const structuralFrameHref = routeChannelId
    ? channelHref(serverId, routeChannelId)
    : serverRootHref(serverId)
  const content = routeChannelId
    ? (
        <ChannelRoute
          key={`${serverId}/${routeChannelId}`}
          serverParam={params.serverId}
          channelId={routeChannelId}
        />
      )
    : children

  return (
    <ShellFrame
      view="server"
      activeServerId={serverId}
      frameHref={structuralFrameHref}
      sidebar={sidebar}
      extraDialogs={<>{serverSettingsDialog}{iconCropDialog}</>}
      onOpenActiveServerSettings={onSidebarOpenSettings}
      onOpenActiveServerInvite={onRailOpenActiveInvite}
    >
      {content}
    </ShellFrame>
  )
}
