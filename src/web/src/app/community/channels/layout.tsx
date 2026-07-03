"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useCommunity } from "@/contexts/community/context"
import { useBreakpoint } from "@/components/community/use-breakpoint"
import { useChannelTree } from "@/components/community/use-channel-tree"
import { ShellFrame } from "@/components/community/shell-frame"
import { ChannelSidebar } from "@/components/community/channel-sidebar"
import { ServerSettings } from "@/components/community/server-settings"
import type { MobileZone, SettingsSection } from "@/components/community/_types"
import { canManageServer, type ChannelType } from "@alook/shared"

export default function ServerLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ serverId: string; channelId?: string }>()
  const searchParams = useSearchParams()
  const serverId = decodeURIComponent(params.serverId)
  const hasChannel = !!params.channelId

  const router = useRouter()
  const bp = useBreakpoint()
  const ctx = useCommunity()

  useEffect(() => {
    ctx.setCurrentServerId(serverId)
  }, [serverId]) // eslint-disable-line react-hooks/exhaustive-deps

  const [mobileZone, setMobileZone] = useState<MobileZone>(() => hasChannel ? "messages" : "nav")
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("overview")

  // Close server-scoped dialogs when the user navigates to another server —
  // without this, settings for server A would remain open after switching
  // to server B, mixing A's draft with B's loaded metadata.
  useEffect(() => {
    setServerSettingsOpen(false)
    setSettingsSection("overview")
  }, [serverId])

  useEffect(() => {
    if (searchParams.get("settings") === "1") {
      setServerSettingsOpen(true)
      router.replace(`/community/channels/${serverId}`)
    }
  }, [searchParams, serverId, router])

  const categories = ctx.currentServer?.categories ?? []
  const channelTree = useChannelTree(categories)

  const goHome = useCallback(() => {
    setMobileZone("nav")
    router.push("/community/me")
  }, [router])
  const goServer = useCallback(() => { setMobileZone("nav") }, [])

  const myMember = ctx.members.find((m) => m.userId === ctx.currentUser.id)
  const isAdmin = canManageServer(myMember?.role)

  const setActiveChannel = useCallback((id: string) => {
    // Only navigate — do NOT eagerly set the context's currentChannelId here.
    // The currently-mounted ChannelView is still keyed to the old channelId;
    // flipping the context now triggers its reset effect (messagesLoading=true)
    // while the URL still points at the OLD channel, so the loading skeleton
    // renders using the old channel's type for one frame (e.g. forum skeleton
    // when switching from forum → text). Letting the newly-mounted ChannelView
    // sync the context in its own useEffect keeps skeleton type consistent
    // with the target channel.
    router.push(`/community/channels/${serverId}/${id}`)
    ctx.markChannelRead(id)
    channelTree.markRead(id)
    if (bp === "mobile") setMobileZone("messages")
  }, [router, serverId, ctx.markChannelRead, channelTree.markRead, bp]) // eslint-disable-line react-hooks/exhaustive-deps

  const onSidebarOpenSettings = useCallback((section?: SettingsSection) => {
    if (section) setSettingsSection(section)
    setServerSettingsOpen(true)
  }, [])

  const onBlockedCreate = useCallback(() => {
    toast("Only admins can create channels in a private category")
  }, [])

  const mutedChannels = useMemo(
    () => Object.fromEntries(
      Object.entries(ctx.channelNotif).map(([k, v]) => [k, v === "Nothing"])
    ),
    [ctx.channelNotif]
  )

  const onCreateChannelInSidebar = useCallback((categoryId: string, name: string, type: ChannelType) => {
    ctx.createChannel(serverId, categoryId, name, type)
  }, [ctx.createChannel, serverId]) // eslint-disable-line react-hooks/exhaustive-deps
  const onCreateCategoryInSidebar = useCallback((name: string, opts?: { private?: boolean }) => {
    ctx.createCategory(serverId, name, opts)
  }, [ctx.createCategory, serverId]) // eslint-disable-line react-hooks/exhaustive-deps
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
    ctx.deleteChannel(channelId)
  }, [ctx.deleteChannel]) // eslint-disable-line react-hooks/exhaustive-deps
  const onDeleteCategoryInSidebar = useCallback((categoryId: string) => {
    ctx.deleteCategory(serverId, categoryId)
  }, [ctx.deleteCategory, serverId]) // eslint-disable-line react-hooks/exhaustive-deps
  const onUpdateCategoryInSidebar = useCallback((categoryId: string, opts: { name?: string; isPrivate?: boolean }) => {
    ctx.updateCategory(serverId, categoryId, opts)
  }, [ctx.updateCategory, serverId]) // eslint-disable-line react-hooks/exhaustive-deps
  const onReorderCategoriesInSidebar = useCallback((categoryIds: string[]) => {
    ctx.reorderCategories(serverId, categoryIds)
  }, [ctx.reorderCategories, serverId]) // eslint-disable-line react-hooks/exhaustive-deps
  const onReorderChannelsInSidebar = useCallback((channelIds: string[]) => {
    ctx.reorderChannels(serverId, channelIds)
  }, [ctx.reorderChannels, serverId]) // eslint-disable-line react-hooks/exhaustive-deps

  const channelProps = useMemo(() => ({
    tree: channelTree,
    serverName: ctx.currentServer?.name ?? "",
    activeChannel: ctx.currentChannelMeta?.parentChannelId ?? ctx.currentChannelId ?? "",
    isAdmin,
    currentUserId: ctx.currentUser.id,
    loading: !ctx.currentServer,
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
  }), [
    channelTree, ctx.currentServer, ctx.currentChannelMeta?.parentChannelId,
    ctx.currentChannelId, isAdmin, ctx.currentUser.id, setActiveChannel,
    onSidebarOpenSettings, onBlockedCreate, mutedChannels,
    onCreateChannelInSidebar, onCreateCategoryInSidebar, onRenameChannel,
    onDeleteChannelInSidebar, onDeleteCategoryInSidebar, onUpdateCategoryInSidebar,
    onReorderCategoriesInSidebar, onReorderChannelsInSidebar,
  ])

  const openProfile = (name: string, e: React.MouseEvent) => {
    // Delegate to the shell's registered openProfile — this is the same
    // handler ShellFrame wires into ctx.registerUiHandlers.
    ctx.openProfile(name, e)
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
          serverName={ctx.currentServer?.name ?? ""}
          serverDescription={ctx.currentServer?.description ?? ""}
          serverIcon={ctx.currentServer?.icon ?? null}
          members={ctx.members}
          membersLoading={ctx.membersLoading}
          membersLoadingMore={ctx.membersLoadingMore}
          membersHasMore={ctx.membersHasMore}
          membersTotal={ctx.membersTotal}
          onLoadMoreMembers={ctx.loadMoreMembers}
          onSearchMembers={ctx.searchMembers}
          invites={ctx.invites}
          invitesLoading={ctx.invitesLoading}
          auditLog={ctx.auditLog}
          auditLogLoading={ctx.auditLogLoading}
          onKickMember={(name) => { const m = ctx.members.find((x) => x.name === name); if (m) ctx.kickMember(m.id) }}
          onSetRole={(name, role) => { const m = ctx.members.find((x) => x.name === name); if (m) ctx.setMemberRole(m.id, role) }}
          onRevokeInvite={(code) => ctx.revokeInvite(code)}
          onCreateInvite={() => ctx.createInvite()}
          onCopyInvite={(code) => { navigator.clipboard?.writeText(`${window.location.origin}/community/invite/${code}`); toast("Invite copied") }}
          onDeleteServer={async () => { closeSettings(); await ctx.deleteServer(serverId); router.push("/community/me") }}
          onUploadIcon={() => {
            const input = document.createElement("input"); input.type = "file"; input.accept = "image/*"
            input.onchange = async () => { const f = input.files?.[0]; if (f) await ctx.uploadServerIcon(serverId, f) }
            input.click()
          }}
          onUpdateServer={(name, desc) => ctx.updateServer(name, desc)}
          notifLevel={ctx.notifLevel}
          onSetNotifLevel={(level) => ctx.setServerNotifLevel(serverId, level)}
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
