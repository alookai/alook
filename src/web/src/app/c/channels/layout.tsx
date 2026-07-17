"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useChannelTree } from "@/components/community/use-channel-tree"
import { patchChannelUnread } from "@/hooks/community/server-detail-cache"
import type { ServerDetail } from "@/hooks/community/use-servers"
import { ShellFrame } from "@/components/community/shell-frame"
import { ChannelSidebar } from "@/components/community/channel-sidebar"
import { ServerSettings } from "@/components/community/server-settings"
import { ImageCropDialog } from "@/components/community/image-crop-dialog"
import { validateIconSourceFile } from "@/lib/community/image-crop"
import type { MobileZone, SettingsSection } from "@/components/community/_types"
import { canManageServer, type ChannelType } from "@alook/shared"
import { resolveRowPresence } from "@/lib/community/presence"
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
  pickPostEjectDestination,
} from "@/components/community/eject-server"
import {
  useInvites,
  useAuditLog,
  usePresence,
} from "@/hooks/community/use-server-panels"
import { useCommunityWsStore, useOnlineUserIds } from "@/stores/community/ws"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import {
  useCreateChannel,
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
  const serverId = decodeURIComponent(params.serverId)
  const hasChannel = !!params.channelId

  const router = useRouter()
  const bp = useBreakpoint()
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const { server: currentServer } = useServer(serverId)
  const membersHook = useServerMembers(serverId)
  const onlineUserIds = useOnlineUserIds()
  const userStatuses = useCommunityWsStore((s) => s.userStatuses)
  const enrichedMembers = useMemo(
    () =>
      membersHook.members.map((m) => {
        const liveStatus = userStatuses.get(m.userId)
        return {
          ...m,
          status: resolveRowPresence(m, onlineUserIds, currentUser.id),
          statusEmoji: liveStatus ? liveStatus.emoji : m.statusEmoji,
          statusText: liveStatus ? liveStatus.text : m.statusText,
        }
      }),
    [membersHook.members, onlineUserIds, currentUser.id, userStatuses],
  )
  // Gate admin-only fetches on `isAdmin` so regular members don't fire
  // audit-log 403s and don't waste bandwidth on the invites feed they can't
  // see. `myMember` comes from the raw (not enriched) members list so this
  // stays stable across presence ticks.
  const myMember = membersHook.members.find((m) => m.userId === currentUser.id)
  const isAdmin = canManageServer(myMember?.role)
  // Fetch invites for every member (not just admins) — the invite popover on
  // the sidebar header reuses cached invites to avoid burning the per-server
  // active-invite cap. Non-admins can now create invites too, so the cache is
  // genuinely useful to them as well.
  const { invites, isLoading: invitesLoading } = useInvites(serverId, true)
  const { entries: auditLog, isLoading: auditLogLoading } = useAuditLog(serverId, isAdmin)
  const { online: initialOnline } = usePresence(serverId)
  const notifs = useNotificationSettings()
  const notifLevel = notifs.server[serverId] ?? "Only @mentions"
  const channelNotif = notifs.channel
  const currentChannelId = useCurrentChannelId()
  const currentChannelMeta = useCurrentChannelMeta()

  // Mutations
  const createChannelMut = useCreateChannel()
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
  // Gate on `isFetched && !isFetching`, not on `isLoading`. TanStack v5
  // `isLoading` is only true on the very first fetch — after any WS
  // invalidate, reconnect, or IDB rehydrate, `isLoading=false` even while
  // `servers=[]` between refetches. Using `isLoading` alone false-triggered
  // this eject on every reload (see the "You're no longer in this server"
  // toast on refresh regression). Also gate on the `!ejectedRef` to prevent
  // a re-fire while the redirect is in flight.
  const serversList = useServers()
  const ejectedRef = useRef(false)
  useEffect(() => {
    if (ejectedRef.current) return
    if (!serversList.isFetched || serversList.isFetching) return
    const inRail = serversList.servers.some((s) => s.id === serverId)
    if (inRail) return
    ejectedRef.current = true
    const voluntary = consumeVoluntaryLeave(serverId)
    if (!voluntary) toast("You're no longer in this server")
    router.replace(pickPostEjectDestination(serversList.servers, serverId))
  }, [serverId, serversList.isFetched, serversList.isFetching, serversList.servers, router])
  // Reset the guard when the URL changes to a NEW server id — otherwise
  // navigating server → dangling-server → server would leave the ref
  // latched and skip the eject.
  useEffect(() => {
    ejectedRef.current = false
  }, [serverId])

  // Seed the presence set on server switch — WS `presence.update` keeps it
  // fresh after this initial hydration. `hydratePresence` is an atomic
  // one-shot replacement AND no-ops when the incoming list matches current
  // state — critical to avoid a render loop when `initialOnline`'s reference
  // shifts on re-render (loading state, cache tick) without semantic change.
  useEffect(() => {
    useCommunityWsStore.getState().hydratePresence(initialOnline)
  }, [initialOnline])

  const [mobileZone, setMobileZone] = useState<MobileZone>(() => hasChannel ? "messages" : "nav")
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
    const wantsSettings = searchParams.get("settings") === "1"
    const wantsInvite = searchParams.get("invite") === "1"
    if (!wantsSettings && !wantsInvite) return

    // These flags land on the bare `/c/channels/:serverId` URL
    // (e.g. right-click a rail server → "Server settings"/"Invite to
    // Server"), which is also the URL the sibling default-channel page
    // redirects away from once it knows the server's first channel. When
    // that server's detail query is already warm in the cache, both
    // redirects fire in the very same commit — and since React runs a
    // child's effects before its parent's, our `router.replace` below would
    // run *after* the page's channel redirect and clobber it, stranding the
    // URL on the channel-less server root. Wait for that race to resolve
    // (channel present, or confirmed there are none) before stripping the
    // query so we don't fight the page's own navigation — once it lands on
    // a channel URL, that URL has no query string left to strip anyway.
    const stillRedirecting =
      !hasChannel && !!currentServer && currentServer.categories.some((c) => c.channels.length > 0)
    if (stillRedirecting) return

    router.replace(
      hasChannel ? `/c/channels/${serverId}/${params.channelId}` : `/c/channels/${serverId}`,
    )
  }, [searchParams, serverId, router, hasChannel, currentServer, params.channelId])

  const categories = currentServer?.categories ?? []
  const channelTree = useChannelTree(categories)

  const goHome = useCallback(() => {
    setMobileZone("nav")
    router.push("/c/me")
  }, [router])
  const goServer = useCallback(() => { setMobileZone("nav") }, [])

  const setActiveChannel = useCallback((id: string) => {
    // Only navigate — do NOT eagerly set the store's currentChannelId here.
    // The currently-mounted ChannelView is still keyed to the old channelId;
    // flipping the store now triggers its reset effect (messagesLoading=true)
    // while the URL still points at the OLD channel, so the loading skeleton
    // renders using the old channel's type for one frame. Letting the newly-
    // mounted ChannelView sync the store in its own useEffect keeps skeleton
    // type consistent with the target channel.
    //
    // #3: also do NOT eagerly mark the channel read. The
    // IntersectionObserver in `useChannelWatermark` is authoritative — it
    // advances the pointer as the user actually looks at messages. Clicking
    // the sidebar is not "I read everything"; it's just a navigation event.
    // `channelTree.markRead(id)` is a client-only tint (unread flag on the
    // sidebar row) — kept so the badge fades on click as it did before. If
    // the user then never scrolls to the new messages, the server-side
    // watermark stays put and the badge will re-appear on next refetch,
    // which is the correct behavior.
    //
    // Also patch the `ServerDetail` query cache (not just the local
    // `channelTree` state) to `unread: false` for this channel, via the same
    // `patchChannelUnread` helper the WS handler uses for the opposite
    // direction. This is still just an optimistic *client-side* tint — the
    // server-side watermark stays authoritative, and a subsequent real
    // refetch will correctly re-flip `unread` to `true` if the user never
    // actually scrolled into the channel. Without this cache patch, an
    // unrelated sibling-channel WS patch would resurrect the just-cleared dot
    // before the user even navigates away — `useChannelTree`'s metadata merge
    // trusts the cache unconditionally, so both directions must write to it.
    router.push(`/c/channels/${serverId}/${id}`)
    channelTree.markRead(id)
    queryClient.setQueryData<ServerDetail | undefined>(
      communityKeys.server(serverId),
      (cache) => patchChannelUnread(cache, id, false),
    )
    if (bp === "mobile") setMobileZone("messages")
  }, [router, serverId, channelTree, bp, queryClient])

  const onSidebarOpenSettings = useCallback((section?: SettingsSection) => {
    if (section) setSettingsSection(section)
    setServerSettingsOpen(true)
  }, [])

  const onBlockedCreate = useCallback(() => {
    toast("Only admins can create channels in a private category")
  }, [])

  const mutedChannels = useMemo(
    () => Object.fromEntries(
      Object.entries(channelNotif).map(([k, v]) => [k, v === "Nothing"])
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
  const onRenameChannel = useCallback(async (channelId: string, name: string) => {
    try {
      await apiFetch(`/api/community/channels/${channelId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      })
    } catch (e) {
      toastApiError(e, "Failed to rename channel")
    }
  }, [])
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
    currentChannelId, isAdmin, currentUser.id, setActiveChannel,
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
      <DialogContent className="flex h-[calc(100vh-4rem)] max-h-180 w-[calc(100vw-4rem)] sm:max-w-4xl flex-col gap-0 overflow-hidden rounded-xl p-0" showCloseButton={false}>
        <ServerSettings
          section={settingsSection}
          setSection={setSettingsSection}
          onClose={closeSettings}
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
          invites={invites}
          invitesLoading={invitesLoading}
          auditLog={auditLog}
          auditLogLoading={auditLogLoading}
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
                router.push("/c/me")
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

  return (
    <ShellFrame
      view="server"
      activeServerId={serverId}
      mobileZone={mobileZone}
      setMobileZone={setMobileZone}
      sidebar={sidebar}
      extraDialogs={<>{serverSettingsDialog}{iconCropDialog}</>}
      goHome={goHome}
      goServer={goServer}
    >
      {children}
    </ShellFrame>
  )
}
