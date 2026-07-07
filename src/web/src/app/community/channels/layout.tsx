"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useChannelTree } from "@/components/community/use-channel-tree"
import { ShellFrame } from "@/components/community/shell-frame"
import { ChannelSidebar } from "@/components/community/channel-sidebar"
import { ServerSettings } from "@/components/community/server-settings"
import type { MobileZone, SettingsSection } from "@/components/community/_types"
import { canManageServer, type ChannelType } from "@alook/shared"
import {
  useCommunityStore,
  useCurrentChannelId,
  useCurrentChannelMeta,
} from "@/stores/community"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useServer } from "@/hooks/community/use-servers"
import { useServerMembers } from "@/hooks/community/use-server-members"
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
  const currentUser = useCurrentUser()
  const { server: currentServer } = useServer(serverId)
  const membersHook = useServerMembers(serverId)
  const onlineUserIds = useOnlineUserIds()
  const enrichedMembers = useMemo(
    () =>
      membersHook.members.map((m) => ({
        ...m,
        status: (m.userId === currentUser.id || onlineUserIds.has(m.userId)
          ? "online"
          : "offline") as "online" | "offline",
      })),
    [membersHook.members, onlineUserIds, currentUser.id],
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

  // Close server-scoped dialogs when the user navigates to another server —
  // without this, settings for server A would remain open after switching
  // to server B, mixing A's draft with B's loaded metadata.
  useEffect(() => {
    setServerSettingsOpen(false)
    setSettingsSection("overview")
    setInvitePopoverOpen(false)
  }, [serverId])

  useEffect(() => {
    if (searchParams.get("settings") === "1") {
      setServerSettingsOpen(true)
      router.replace(`/community/channels/${serverId}`)
    }
    if (searchParams.get("invite") === "1") {
      setInvitePopoverOpen(true)
      router.replace(`/community/channels/${serverId}`)
    }
  }, [searchParams, serverId, router])

  const categories = currentServer?.categories ?? []
  const channelTree = useChannelTree(categories)

  const goHome = useCallback(() => {
    setMobileZone("nav")
    router.push("/community/me")
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
    router.push(`/community/channels/${serverId}/${id}`)
    channelTree.markRead(id)
    if (bp === "mobile") setMobileZone("messages")
  }, [router, serverId, channelTree, bp])

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

  const onCreateChannelInSidebar = useCallback((categoryId: string, name: string, type: ChannelType) => {
    createChannelMut.mutate({ serverId, categoryId, name, type }, { onError: () => toast("Failed to create channel") })
  }, [createChannelMut, serverId])
  const onCreateCategoryInSidebar = useCallback((name: string, opts?: { private?: boolean }) => {
    createCategoryMut.mutate({ serverId, name, private: opts?.private }, { onError: () => toast("Failed to create category") })
  }, [createCategoryMut, serverId])
  const onRenameChannel = useCallback(async (channelId: string, name: string) => {
    try {
      await apiFetch(`/api/community/channels/${channelId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to rename channel")
    }
  }, [])
  const onDeleteChannelInSidebar = useCallback((channelId: string) => {
    deleteChannelMut.mutate({ serverId, channelId }, { onError: () => toast("Failed to delete channel") })
  }, [deleteChannelMut, serverId])
  const onDeleteCategoryInSidebar = useCallback((categoryId: string) => {
    deleteCategoryMut.mutate({ serverId, categoryId }, { onError: () => toast("Failed to delete category") })
  }, [deleteCategoryMut, serverId])
  const onUpdateCategoryInSidebar = useCallback((categoryId: string, opts: { name?: string; isPrivate?: boolean }) => {
    updateCategoryMut.mutate({ serverId, categoryId, name: opts.name, isPrivate: opts.isPrivate }, { onError: () => toast("Failed to update category") })
  }, [updateCategoryMut, serverId])
  const onReorderCategoriesInSidebar = useCallback((categoryIds: string[]) => {
    reorderCategoriesMut.mutate({ serverId, categoryIds }, { onError: () => toast("Failed to save category order") })
  }, [reorderCategoriesMut, serverId])
  const onReorderChannelsInSidebar = useCallback((channelIds: string[]) => {
    reorderChannelsMut.mutate({ serverId, channelIds }, { onError: () => toast("Failed to save channel order") })
  }, [reorderChannelsMut, serverId])

  const channelProps = useMemo(() => ({
    tree: channelTree,
    serverName: currentServer?.name ?? "",
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
    serverId, invitePopoverOpen,
  ])

  const openProfile = (name: string, e: React.MouseEvent) => {
    // Delegate to the shell's registered openProfile via the community store.
    useCommunityStore.getState().uiHandlers.openProfile?.(name, e)
  }

  const closeSettings = () => { setServerSettingsOpen(false); setSettingsSection("overview") }

  const sidebar = useCallback((opts: { noHeader?: boolean } = {}) => (
    <ChannelSidebar {...channelProps} {...opts} />
  ), [channelProps])

  const serverSettingsDialog = (
    <Dialog open={serverSettingsOpen} onOpenChange={(o) => { if (!o) closeSettings() }}>
      <DialogContent className="flex h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] sm:max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0" showCloseButton={false}>
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
          onKickMember={(name) => {
            const m = membersHook.members.find((x) => x.name === name)
            if (m) {
              kickMemberMut.mutate({ serverId, memberId: m.id }, {
                onSuccess: () => toast("Member kicked"),
                onError: () => toast("Failed to kick member"),
              })
            }
          }}
          onSetRole={(name, role) => {
            const m = membersHook.members.find((x) => x.name === name)
            if (m) {
              setMemberRoleMut.mutate({ serverId, memberId: m.id, role }, {
                onSuccess: () => toast("Role updated"),
                onError: () => toast("Failed to update role"),
              })
            }
          }}
          onRevokeInvite={(code) => revokeInviteMut.mutate({ serverId, code }, {
            onSuccess: () => toast("Invite revoked"),
            onError: () => toast("Failed to revoke invite"),
          })}
          onCopyInvite={(code) => { navigator.clipboard?.writeText(`${window.location.origin}/community/invite/${code}`); toast("Invite copied") }}
          onDeleteServer={async () => {
            closeSettings()
            deleteServerMut.mutate({ serverId }, {
              onSuccess: () => {
                toast("Server deleted")
                useCommunityStore.getState().setCurrentServerId(null)
                router.push("/community/me")
              },
              onError: () => toast("Failed to delete server"),
            })
          }}
          onUploadIcon={() => {
            const input = document.createElement("input"); input.type = "file"; input.accept = "image/*"
            input.onchange = async () => {
              const f = input.files?.[0]
              if (f) {
                uploadServerIconMut.mutate({ serverId, file: f }, {
                  onSuccess: () => toast("Server icon updated"),
                  onError: () => toast("Failed to upload icon"),
                })
              }
            }
            input.click()
          }}
          onUpdateServer={(name, desc) =>
            updateServerMut.mutate({ serverId, name, description: desc }, {
              onSuccess: () => toast("Server updated"),
              onError: () => toast("Failed to update server"),
            })
          }
          notifLevel={notifLevel}
          onSetNotifLevel={(level) => setServerNotifMut.mutate({ serverId, level }, {
            onError: () => toast("Failed to update notification level"),
          })}
          onOpenProfile={openProfile}
        />
      </DialogContent>
    </Dialog>
  )

  return (
    <ShellFrame
      view="server"
      activeServerId={serverId}
      mobileZone={mobileZone}
      setMobileZone={setMobileZone}
      sidebar={sidebar}
      extraDialogs={serverSettingsDialog}
      goHome={goHome}
      goServer={goServer}
    >
      {children}
    </ShellFrame>
  )
}
