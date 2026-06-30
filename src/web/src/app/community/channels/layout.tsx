"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { AppSurface } from "@/components/ui/app-surface"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ChevronLeft } from "lucide-react"
import { useCommunity } from "@/contexts/community/context"
import { useBreakpoint } from "@/components/community/use-breakpoint"
import { useChannelTree } from "@/components/community/use-channel-tree"
import { Shell } from "@/components/community/shell"
import { ServerRail } from "@/components/community/server-rail"
import { MobileRail } from "@/components/community/mobile-rail"
import { ChannelSidebar } from "@/components/community/channel-sidebar"
import { DmSidebar } from "@/components/community/dm-sidebar"
import { UserBar } from "@/components/community/user-bar"
import { InboxPopover } from "@/components/community/community-inbox-popover"
import { UserSettings } from "@/components/community/edit-profile-dialog"
import { ServerSettings } from "@/components/community/server-settings"
import { ProfileCard } from "@/components/community/profile-card"
import { ImageLightbox } from "@/components/community/image-lightbox"
import type { MobileZone, View, Profile, SettingsSection } from "@/components/community/_types"
import { canManageServer, type ChannelType } from "@alook/shared"
import { signOut } from "@/lib/auth-client"

export default function ServerLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ serverId: string; channelId?: string }>()
  const searchParams = useSearchParams()
  const serverId = decodeURIComponent(params.serverId)
  const isAtMe = serverId === "@me"
  const hasChannel = !!params.channelId

  const router = useRouter()
  const bp = useBreakpoint()
  const ctx = useCommunity()

  // Sync the context's current server id from the route param
  useEffect(() => {
    ctx.setCurrentServerId(isAtMe ? "@me" : serverId)
  }, [serverId, isAtMe]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Local UI state ────────────────────────────────────────────────────────
  const [view, setView] = useState<View>(isAtMe ? "dm" : "server")
  const [mobileZone, setMobileZone] = useState<MobileZone>(() => hasChannel ? "messages" : "channels")
  const [editingProfile, setEditingProfile] = useState(false)
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("overview")
  const [profile, setProfile] = useState<{ data: Profile; x: number; y: number } | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    setView(isAtMe ? "dm" : "server")
  }, [isAtMe])

  useEffect(() => {
    if (searchParams.get("settings") === "1") {
      setServerSettingsOpen(true)
      router.replace(`/community/channels/${serverId}`)
    }
  }, [searchParams, serverId, router])


  // Build channel tree from server categories
  const categories = ctx.currentServer?.categories ?? []
  const channelTree = useChannelTree(categories)

  // ── Rail props ────────────────────────────────────────────────────────────
  const folderServerIds = useMemo(() => {
    const s = new Set<string>()
    for (const f of ctx.folders) for (const srv of f.servers) s.add(srv.id)
    return s
  }, [ctx.folders])
  const railServers = useMemo(() =>
    ctx.servers.filter((s) => !folderServerIds.has(s.id)).map((s) => ({ ...s, active: s.id === serverId })),
    [ctx.servers, serverId, folderServerIds]
  )

  const goHome = useCallback(() => {
    setView("dm"); setMobileZone("channels"); router.push("/community/channels/@me")
  }, [router])
  const goServer = useCallback(() => { setView("server"); setMobileZone("channels") }, [])

  const onRailServerNavigate = useCallback((id: string) => { router.push(`/community/channels/${id}`) }, [router])
  const onRailCreateServer = useCallback(async (name: string, icon?: File) => {
    const newId = await ctx.createServer(name)
    if (newId) {
      if (icon) ctx.uploadServerIcon(newId, icon)
      router.push(`/community/channels/${newId}`)
    }
  }, [ctx.createServer, ctx.uploadServerIcon, router])
  const onRailJoinServer = useCallback(async (invite: string) => {
    const newId = await ctx.joinServer(invite)
    if (newId) router.push(`/community/channels/${newId}`)
  }, [ctx.joinServer, router])
  const onRailLeaveServer = useCallback((id: string) => { ctx.leaveServer(id) }, [ctx.leaveServer])
  const onRailOpenSettings = useCallback((id?: string) => {
    if (id && id !== serverId) {
      router.push(`/community/channels/${id}?settings=1`)
    } else {
      setServerSettingsOpen(true)
    }
  }, [serverId, router])
  const onRailUngroupFolder = useCallback((fId: string) => { ctx.deleteServerFolder(fId) }, [ctx.deleteServerFolder])
  const onRailReorderRail = useCallback((ids: string[]) => { ctx.reorderServers(ids) }, [ctx.reorderServers])
  const onRailReorderFolders = useCallback((ids: string[]) => { ctx.reorderFolders(ids) }, [ctx.reorderFolders])
  const onRailFolderItemsChange = useCallback((fId: string, ids: string[]) => { ctx.updateFolderItems(fId, ids) }, [ctx.updateFolderItems])
  const onRailDragCreateFolder = useCallback((a: string, b: string) => { ctx.createServerFolderWith(a, b) }, [ctx.createServerFolderWith])

  const railProps = useMemo(() => ({
    servers: railServers,
    folders: ctx.folders,
    activeServerId: isAtMe ? undefined : serverId,
    serversLoading: ctx.serversLoading,
    setMobileZone,
    view,
    onHome: goHome,
    onServer: goServer,
    onServerNavigate: onRailServerNavigate,
    onCreateServer: onRailCreateServer,
    onJoinServer: onRailJoinServer,
    onLeaveServer: onRailLeaveServer,
    onOpenSettings: onRailOpenSettings,
    onUngroupFolder: onRailUngroupFolder,
    onReorderRail: onRailReorderRail,
    onReorderFolders: onRailReorderFolders,
    onFolderItemsChange: onRailFolderItemsChange,
    onDragCreateFolder: onRailDragCreateFolder,
  }), [
    railServers, ctx.folders, isAtMe, serverId, ctx.serversLoading, view,
    goHome, goServer, onRailServerNavigate, onRailCreateServer, onRailJoinServer,
    onRailLeaveServer, onRailOpenSettings, onRailUngroupFolder, onRailReorderRail,
    onRailReorderFolders, onRailFolderItemsChange, onRailDragCreateFolder,
  ])

  // ── Channel sidebar props ─────────────────────────────────────────────────
  const myMember = ctx.members.find((m) => m.userId === ctx.currentUser.id)
  const isAdmin = canManageServer(myMember?.role)

  const setActiveChannel = useCallback((id: string) => {
    router.push(`/community/channels/${serverId}/${id}`)
    ctx.setCurrentChannelId(id)
    ctx.markChannelRead(id)
    channelTree.markRead(id)
    if (bp === "mobile") setMobileZone("messages")
  }, [router, serverId, ctx.setCurrentChannelId, ctx.markChannelRead, channelTree.markRead, bp])

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
  }, [ctx.createChannel, serverId])
  const onCreateCategoryInSidebar = useCallback((name: string, opts?: { private?: boolean }) => {
    ctx.createCategory(serverId, name, opts)
  }, [ctx.createCategory, serverId])
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
  }, [ctx.deleteChannel])
  const onDeleteCategoryInSidebar = useCallback((categoryId: string) => {
    ctx.deleteCategory(serverId, categoryId)
  }, [ctx.deleteCategory, serverId])
  const onUpdateCategoryInSidebar = useCallback((categoryId: string, opts: { name?: string; isPrivate?: boolean }) => {
    ctx.updateCategory(serverId, categoryId, opts)
  }, [ctx.updateCategory, serverId])
  const onReorderCategoriesInSidebar = useCallback((categoryIds: string[]) => {
    ctx.reorderCategories(serverId, categoryIds)
  }, [ctx.reorderCategories, serverId])
  const onReorderChannelsInSidebar = useCallback((channelIds: string[]) => {
    ctx.reorderChannels(serverId, channelIds)
  }, [ctx.reorderChannels, serverId])

  const channelProps = useMemo(() => ({
    tree: channelTree,
    serverName: ctx.currentServer?.name ?? "",
    activeChannel: ctx.currentChannelMeta?.parentChannelId ?? ctx.currentChannelId ?? "",
    isAdmin,
    currentUserId: ctx.currentUser.id,
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
    channelTree, ctx.currentServer?.name, ctx.currentChannelMeta?.parentChannelId,
    ctx.currentChannelId, isAdmin, ctx.currentUser.id, setActiveChannel,
    onSidebarOpenSettings, onBlockedCreate, mutedChannels,
    onCreateChannelInSidebar, onCreateCategoryInSidebar, onRenameChannel,
    onDeleteChannelInSidebar, onDeleteCategoryInSidebar, onUpdateCategoryInSidebar,
    onReorderCategoriesInSidebar, onReorderChannelsInSidebar,
  ])

  // ── DM sidebar props ──────────────────────────────────────────────────────
  const enterDm = useCallback((id: string) => {
    ctx.setCurrentChannelId(id)
    ctx.markDmRead(id)
    router.push(`/community/channels/@me/${id}`)
    if (bp === "mobile") setMobileZone("messages")
  }, [ctx.setCurrentChannelId, ctx.markDmRead, router, bp])

  const onShowFriends = useCallback(() => {
    ctx.setCurrentChannelId(null)
    router.push("/community/channels/@me")
    if (bp === "mobile") setMobileZone("messages")
  }, [ctx.setCurrentChannelId, router, bp])

  // ── Profile card ──────────────────────────────────────────────────────────
  const openProfile = (name: string, e: React.MouseEvent) => {
    const isSelf = name === ctx.currentUser.name
    if (isSelf) {
      const data: Profile = {
        name: ctx.currentUser.name,
        avatar: ctx.currentUser.avatar || ctx.currentUser.name.charAt(0).toUpperCase(),
        role: "You",
        about: ctx.currentUser.aboutMe ?? "",
        mutual: 0,
        tags: [],
      }
      setProfile({ data, x: e.clientX, y: e.clientY })
      return
    }
    const member = (ctx.members ?? []).find((m) => m.name === name)
      ?? (ctx.friends ?? []).find((f) => f.name === name)
    const role: string = member && "role" in member ? (member as { role: string }).role : "member"
    const about: string = member && "sub" in member && (member as { sub: string }).sub ? (member as { sub: string }).sub : ""
    const displayRole = role.charAt(0).toUpperCase() + role.slice(1)
    const data: Profile = {
      name,
      avatar: member?.avatar ?? name.charAt(0).toUpperCase(),
      role: displayRole,
      about,
      mutual: 0,
      tags: role !== "member" ? [displayRole] : [],
    }
    setProfile({ data, x: e.clientX, y: e.clientY })
    const userId = member && "userId" in member ? (member as { userId: string }).userId : member?.id
    if (userId) {
      apiFetch<{ aboutMe?: string; mutualServers?: number }>(`/api/community/users/${userId}/profile`)
        .then((p) => {
          setProfile((prev) => prev ? { ...prev, data: { ...prev.data, about: p.aboutMe ?? prev.data.about, mutual: p.mutualServers ?? 0 } } : prev)
        })
        .catch(() => {})
    }
  }

  // Register UI handlers so pages can trigger layout actions via context
  useEffect(() => {
    ctx.registerUiHandlers({
      previewImage: (url) => setPreview(url),
      openProfile,
      goBackMobile: () => setMobileZone("channels"),
    })
  })

  const profileMessage = async (name: string) => {
    setProfile(null)
    const member = ctx.members.find((m) => m.name === name)
    const friend = ctx.friends.find((f) => f.name === name)
    const targetUserId = member?.userId ?? friend?.userId
    if (!targetUserId) {
      toast(`Could not find user ${name}`)
      return
    }
    const dmId = await ctx.createOrGetDm(targetUserId)
    if (dmId) {
      router.push(`/community/channels/@me/${dmId}`)
    }
  }

  // ── Inbox (global) ────────────────────────────────────────────────────────
  const inboxElement = (
    <InboxPopover
      feed={ctx.inboxFeed}
      mentions={ctx.mentions}
      onOpenItem={(id) => { ctx.openInboxItem(id); router.push(`/community/channels/${id}`) }}
      onOpenMention={(mention) => { if (mention.serverId && mention.channelId) router.push(`/community/channels/${mention.serverId}/${mention.channelId}`) }}
      onMarkAllRead={ctx.markAllInboxRead}
      onDismissItem={ctx.dismissInboxItem}
      onDeleteMention={ctx.deleteMention}
    />
  )
  const inboxHasUnread = ctx.inboxFeed?.some((f) => f.unread) ?? false

  const blockedUserIds = useMemo(() => new Set(ctx.blocked.map((b) => b.userId ?? b.id)), [ctx.blocked])

  // ── Left sidebar rendering ────────────────────────────────────────────────
  const sidebar = (opts: { noHeader?: boolean } = {}) =>
    isAtMe || view === "dm" ? (
      <DmSidebar
        dms={ctx.dms ?? []}
        activeDm={ctx.currentChannelId}
        blockedUserIds={blockedUserIds}
        onPickDm={enterDm}
        onShowFriends={onShowFriends}
      />
    ) : (
      <ChannelSidebar {...channelProps} {...opts} />
    )

  // ── Dialogs ───────────────────────────────────────────────────────────────
  const closeSettings = () => { setServerSettingsOpen(false); setSettingsSection("overview") }
  const dialogs = (
    <>
      <Dialog open={editingProfile} onOpenChange={(o) => { if (!o) setEditingProfile(false) }}>
        <DialogContent className="flex h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] sm:max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0" showCloseButton={false}>
          <UserSettings
            onClose={() => setEditingProfile(false)}
            userName={ctx.currentUser.name}
            aboutMe={ctx.currentUser.aboutMe ?? ""}
            onSave={async (data) => {
              try {
                await apiFetch("/api/community/users/me/profile", {
                  method: "PATCH",
                  body: JSON.stringify(data),
                })
                ctx.setCurrentUser((u) => ({
                  ...u,
                  ...(data.name ? { name: data.name } : {}),
                  ...(data.aboutMe !== undefined ? { aboutMe: data.aboutMe } : {}),
                }))
              } catch { toast("Failed to save profile") }
            }}
            onLogout={async () => { await signOut(); router.push("/sign-in") }}
          />
        </DialogContent>
      </Dialog>
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
            invites={ctx.invites}
            auditLog={ctx.auditLog}
            onKickMember={(name) => { const m = ctx.members.find((x) => x.name === name); if (m) ctx.kickMember(m.id) }}
            onSetRole={(name, role) => { const m = ctx.members.find((x) => x.name === name); if (m) ctx.setMemberRole(m.id, role) }}
            onRevokeInvite={(code) => ctx.revokeInvite(code)}
            onCreateInvite={() => ctx.createInvite()}
            onCopyInvite={(code) => { navigator.clipboard?.writeText(`${window.location.origin}/community/invite/${code}`); toast("Invite copied") }}
            onDeleteServer={async () => { closeSettings(); await ctx.deleteServer(serverId); router.push("/community/channels/@me") }}
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
    </>
  )

  // ── Sidebar panel width tracking (for floating UserBar) ────────────────────
  const sidebarPanelRef = useRef<HTMLDivElement>(null)
  const [sidebarW, setSidebarW] = useState(240)
  useEffect(() => {
    const el = sidebarPanelRef.current
    if (!el) return
    setSidebarW(el.offsetWidth)
    const ro = new ResizeObserver(([e]) => setSidebarW(e!.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [bp])

  // ── Desktop ───────────────────────────────────────────────────────────────
  if (bp === "desktop") {
    return (
      <Shell>
        <ServerRail {...railProps} bottomInset={60} />
        <div className="relative flex-1 flex flex-col min-w-0 pt-2 pr-2 pb-2">
          <AppSurface>
            <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
              <ResizablePanel defaultSize="24%" minSize={160} maxSize={360} className="flex flex-col pb-14 bg-sidebar">
                <div ref={sidebarPanelRef} className="flex min-h-0 flex-1 flex-col">
                  {sidebar()}
                </div>
              </ResizablePanel>
              <ResizableHandle className="bg-transparent" />
              <ResizablePanel defaultSize="76%" className="flex min-w-0 flex-col bg-background">
                {children}
              </ResizablePanel>
            </ResizablePanelGroup>
          </AppSurface>
          <div className="absolute bottom-2 left-0 z-10" style={{ width: sidebarW + 56, marginLeft: -56 }}>
            <UserBar user={{ name: ctx.currentUser.name, avatar: ctx.currentUser.avatar }} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} inbox={inboxElement} hasUnread={inboxHasUnread} />
          </div>
        </div>
        {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === ctx.currentUser.name} />}
        {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
        {dialogs}
      </Shell>
    )
  }

  // ── Mobile ────────────────────────────────────────────────────────────────
  return (
    <Shell>
      {mobileZone === "rail" && (
        <MobileRail servers={railServers} folders={ctx.folders} onPick={() => setMobileZone("channels")} onHome={goHome} onServer={goServer} onServerNavigate={railProps.onServerNavigate} onAddServer={railProps.onCreateServer} onJoinServer={() => { /* Join is handled by the dialog inside MobileRail */ }} view={view} />
      )}
      {mobileZone === "channels" && (
        <div className="flex min-h-0 flex-1 flex-col bg-sidebar">
          <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/40 px-3">
            <Button variant="ghost" size="icon-sm" onClick={() => setMobileZone("rail")} className="text-muted-foreground hover:text-foreground" aria-label="Back to servers">
              <ChevronLeft className="size-5" />
            </Button>
            <span className="ml-1 truncate text-base font-semibold">{isAtMe ? "Direct Messages" : ctx.currentServer?.name ?? ""}</span>
          </header>
          <div className="flex min-h-0 flex-1">{sidebar({ noHeader: true })}</div>
          <UserBar user={{ name: ctx.currentUser.name, avatar: ctx.currentUser.avatar }} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} inbox={inboxElement} hasUnread={inboxHasUnread} />
        </div>
      )}
      {mobileZone === "messages" && (
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          {children}
        </div>
      )}
      {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === ctx.currentUser.name} />}
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
      {dialogs}
    </Shell>
  )
}
