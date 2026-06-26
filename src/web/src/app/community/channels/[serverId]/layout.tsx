"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
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
import { UserSettings } from "@/components/community/edit-profile-dialog"
import { ServerSettings } from "@/components/community/server-settings"
import { InboxPopover } from "@/components/community/community-inbox-popover"
import { Overlay } from "@/components/community/overlay"
import { ProfileCard } from "@/components/community/profile-card"
import { ImageLightbox } from "@/components/community/image-lightbox"
import type { MobileZone, View, Profile, SettingsSection } from "@/components/community/_types"

export default function ServerLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ serverId: string }>()
  const searchParams = useSearchParams()
  const serverId = decodeURIComponent(params.serverId)
  const isAtMe = serverId === "@me"

  const router = useRouter()
  const bp = useBreakpoint()
  const ctx = useCommunity()

  // Sync the context's current server id from the route param
  useEffect(() => {
    ctx.setCurrentServerId(isAtMe ? "@me" : serverId)
  }, [serverId, isAtMe]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Local UI state ────────────────────────────────────────────────────────
  const [view, setView] = useState<View>(isAtMe ? "dm" : "server")
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mobileZone, setMobileZone] = useState<MobileZone>("messages")
  const [editingProfile, setEditingProfile] = useState(false)
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("overview")
  const [profile, setProfile] = useState<{ data: Profile; x: number; y: number } | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

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

  const goHome = () => { setView("dm"); setMobileZone("channels"); router.push("/community/channels/@me") }
  const goServer = () => { setView("server"); setMobileZone("channels") }

  const railProps = {
    servers: railServers,
    folders: ctx.folders,
    activeServerId: isAtMe ? undefined : serverId,
    serversLoading: ctx.serversLoading,
    setMobileZone,
    view,
    onHome: goHome,
    onServer: goServer,
    onServerNavigate: (id: string) => { router.push(`/community/channels/${id}`) },
    onCreateServer: async (name: string, icon?: File) => {
      const newId = await ctx.createServer(name)
      if (newId) {
        if (icon) ctx.uploadServerIcon(newId, icon)
        router.push(`/community/channels/${newId}`)
      }
    },
    onJoinServer: async (invite: string) => {
      const newId = await ctx.joinServer(invite)
      if (newId) router.push(`/community/channels/${newId}`)
    },
    onLeaveServer: (id: string) => { ctx.leaveServer(id) },
    onOpenSettings: (id?: string) => {
      if (id && id !== serverId) {
        router.push(`/community/channels/${id}?settings=1`)
      } else {
        setServerSettingsOpen(true)
      }
    },
    onUngroupFolder: (fId: string) => { ctx.deleteServerFolder(fId) },
    onReorderRail: (ids: string[]) => { ctx.reorderServers(ids) },
    onReorderFolders: (ids: string[]) => { ctx.reorderFolders(ids) },
    onFolderItemsChange: (fId: string, ids: string[]) => { ctx.updateFolderItems(fId, ids) },
    onDragCreateFolder: (a: string, b: string) => { ctx.createServerFolderWith(a, b) },
  }

  // ── Channel sidebar props ─────────────────────────────────────────────────
  const channelProps = {
    tree: channelTree,
    serverName: ctx.currentServer?.name ?? "",
    activeChannel: ctx.currentChannelId ?? "",
    setActiveChannel: (id: string) => {
      ctx.setCurrentChannelId(id)
      ctx.markChannelRead(id)
      channelTree.markRead(id)
      if (bp === "tablet") setSidebarOpen(false)
      if (bp === "mobile") setMobileZone("messages")
    },
    onOpenSettings: () => { setServerSettingsOpen(true) },
    onBlockedCreate: () => toast("Only admins can create channels in a private category"),
    mutedChannels: Object.fromEntries(
      Object.entries(ctx.channelNotif).map(([k, v]) => [k, v === "Nothing"])
    ),
    onCreateChannel: (categoryId: string, name: string, type: "text" | "forum") => {
      ctx.createChannel(serverId, categoryId, name, type)
    },
    onCreateCategory: (name: string, opts?: { private?: boolean }) => {
      ctx.createCategory(serverId, name, opts)
    },
    onDeleteChannel: (channelId: string) => {
      ctx.deleteChannel(channelId)
    },
    onDeleteCategory: (categoryId: string) => {
      ctx.deleteCategory(serverId, categoryId)
    },
    onUpdateCategory: (categoryId: string, opts: { name?: string; isPrivate?: boolean }) => {
      ctx.updateCategory(serverId, categoryId, opts)
    },
    onReorderCategories: (categoryIds: string[]) => {
      ctx.reorderCategories(serverId, categoryIds)
    },
    onReorderChannels: (channelIds: string[]) => {
      ctx.reorderChannels(serverId, channelIds)
    },
  }

  // ── DM sidebar props ──────────────────────────────────────────────────────
  const enterDm = (id: string) => {
    ctx.setCurrentChannelId(id)
    ctx.markDmRead(id)
    if (bp === "tablet") setSidebarOpen(false)
    if (bp === "mobile") setMobileZone("messages")
  }

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
    const role: string = member && "role" in member ? (member as { role: string }).role : "Member"
    const about: string = member && "sub" in member && (member as { sub: string }).sub ? (member as { sub: string }).sub : ""
    const data: Profile = {
      name,
      avatar: member?.avatar ?? name.charAt(0).toUpperCase(),
      role,
      about,
      mutual: 0,
      tags: role !== "Member" ? [role] : [],
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
      openSidebar: () => setSidebarOpen(true),
      previewImage: (url) => setPreview(url),
      openProfile,
    })
  })

  const profileMessage = async (name: string, _text: string) => {
    setProfile(null)
    // Find the member/friend to get their user ID
    const member = ctx.members.find((m) => m.name === name) ?? ctx.friends.find((f) => f.name === name)
    if (!member) {
      toast(`Could not find user ${name}`)
      return
    }
    const dmId = await ctx.createOrGetDm(member.id)
    if (dmId) {
      router.push(`/community/channels/@me/${dmId}`)
    }
  }

  // ── Shell chrome ──────────────────────────────────────────────────────────
  const shellProps = {
    appName: isAtMe ? "Friends" : (ctx.currentServer?.name ?? "Alook"),
    appIcon: isAtMe ? "friends" as const : undefined,
    serverIcon: isAtMe ? undefined : (ctx.currentServer?.icon ?? null),
    inbox: (
      <InboxPopover
        feed={ctx.inboxFeed}
        mentions={ctx.mentions}
        onOpenItem={ctx.openInboxItem}
        onMarkAllRead={ctx.markAllInboxRead}
      />
    ),
    hasUnread: ctx.inboxFeed?.some((f) => f.unread) ?? false,
  }

  // ── Left sidebar rendering ────────────────────────────────────────────────
  const sidebar = (opts: { bordered?: boolean; noHeader?: boolean } = {}) =>
    isAtMe || view === "dm" ? (
      <DmSidebar
        dms={ctx.dms ?? []}
        activeDm={ctx.currentChannelId}
        onPickDm={enterDm}
        onShowFriends={() => ctx.setCurrentChannelId(null)}
        {...opts}
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
              } catch { toast("Failed to save profile") }
            }}
            onLogout={() => { window.location.href = "/sign-in" }}
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

  // ── Desktop ───────────────────────────────────────────────────────────────
  if (bp === "desktop") {
    return (
      <Shell {...shellProps}>
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="24%" minSize="20%" maxSize="36%" className="flex flex-col" style={{ background: "var(--d-rail)" }}>
            <div className="flex min-h-0 flex-1">
              <ServerRail {...railProps} />
              {sidebar({ bordered: true })}
            </div>
            <UserBar user={{ name: ctx.currentUser.name, avatar: ctx.currentUser.avatar }} mounted={mounted} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} />
          </ResizablePanel>
          <ResizableHandle className="bg-transparent" />
          <ResizablePanel defaultSize="76%" className="flex min-w-0 flex-col border-t border-r border-border bg-sidebar">
            {children}
          </ResizablePanel>
        </ResizablePanelGroup>
        {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === ctx.currentUser.name} />}
        {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
        {dialogs}
      </Shell>
    )
  }

  // ── Tablet ────────────────────────────────────────────────────────────────
  if (bp === "tablet") {
    return (
      <Shell {...shellProps}>
        <div className="flex min-h-0 flex-1" style={{ background: "var(--d-rail)" }}>
          <ServerRail {...railProps} />
          <div className="flex min-w-0 flex-1 flex-col rounded-tl-xl border-l border-t border-r border-border bg-sidebar">
            {children}
          </div>
        </div>
        {sidebarOpen && (
          <Overlay onClose={() => setSidebarOpen(false)} side="left">
            <div className="flex h-full w-70 flex-col" style={{ background: "var(--d-rail)" }}>
              <div className="flex min-h-0 flex-1">{sidebar()}</div>
              <UserBar user={{ name: ctx.currentUser.name, avatar: ctx.currentUser.avatar }} mounted={mounted} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} />
            </div>
          </Overlay>
        )}
        {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === ctx.currentUser.name} />}
        {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
        {dialogs}
      </Shell>
    )
  }

  // ── Mobile ────────────────────────────────────────────────────────────────
  return (
    <Shell {...shellProps}>
      {mobileZone === "rail" && (
        <MobileRail servers={railServers} folders={ctx.folders} onPick={() => setMobileZone("channels")} onHome={goHome} onServer={goServer} onServerNavigate={railProps.onServerNavigate} onAddServer={railProps.onCreateServer} onJoinServer={() => { /* Join is handled by the dialog inside MobileRail */ }} view={view} />
      )}
      {mobileZone === "channels" && (
        <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--d-rail)" }}>
          <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
            <Button variant="ghost" size="icon-sm" onClick={() => setMobileZone("rail")} className="text-muted-foreground hover:text-foreground" aria-label="Back to servers">
              <ChevronLeft className="size-5" />
            </Button>
            <span className="ml-1 truncate text-base font-semibold">{isAtMe ? "Direct Messages" : ctx.currentServer?.name ?? ""}</span>
          </header>
          <div className="flex min-h-0 flex-1">{sidebar({ noHeader: true })}</div>
          <UserBar user={{ name: ctx.currentUser.name, avatar: ctx.currentUser.avatar }} mounted={mounted} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} />
        </div>
      )}
      {mobileZone === "messages" && (
        <div className="flex min-h-0 flex-1 flex-col bg-sidebar">
          {children}
        </div>
      )}
      {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === ctx.currentUser.name} />}
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
      {dialogs}
    </Shell>
  )
}
