"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useParams } from "next/navigation"
import { toast } from "sonner"
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
import { InboxPopover } from "@/components/community/community-inbox-popover"
import { Overlay } from "@/components/community/overlay"
import { ProfileCard } from "@/components/community/profile-card"
import { ImageLightbox } from "@/components/community/image-lightbox"
import type { MobileZone, View, Profile } from "@/components/community/_types"

export default function ServerLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ serverId: string }>()
  const serverId = params.serverId
  const isAtMe = serverId === "@me"

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
  const [profile, setProfile] = useState<{ data: Profile; x: number; y: number } | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    setView(isAtMe ? "dm" : "server")
  }, [isAtMe])

  // Build channel tree from server categories
  const categories = ctx.currentServer?.categories ?? []
  const channelTree = useChannelTree(categories)

  // ── Rail props ────────────────────────────────────────────────────────────
  const railServers = useMemo(() =>
    ctx.servers.map((s) => ({ ...s, active: s.id === serverId })),
    [ctx.servers, serverId]
  )

  const goHome = () => { setView("dm"); setMobileZone("channels") }
  const goServer = () => { setView("server"); setMobileZone("channels") }

  const railProps = {
    servers: railServers,
    folderServers: ctx.folderServers,
    setMobileZone,
    view,
    onHome: goHome,
    onServer: goServer,
    onCreateServer: (name: string) => { ctx.createServer(name) },
    onJoinServer: (invite: string) => { ctx.joinServer(invite) },
    onLeaveServer: (id: string) => { ctx.leaveServer(id) },
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
    onOpenSettings: () => { /* navigated via link */ },
    onBlockedCreate: () => toast("Only admins can create channels in a private category"),
    mutedChannels: Object.fromEntries(
      Object.entries(ctx.channelNotif).map(([k, v]) => [k, v === "Nothing"])
    ),
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
    const member = ctx.members.find((m) => m.name === name)
      ?? ctx.friends.find((f) => f.name === name)
    const role: string = member && "role" in member ? (member as { role: string }).role : "Member"
    const about: string = member && "sub" in member && (member as { sub: string }).sub ? (member as { sub: string }).sub : "No bio yet."
    const data: Profile = {
      name,
      avatar: member?.avatar ?? name.charAt(0).toUpperCase(),
      role,
      about,
      mutual: 1,
      tags: [role],
    }
    setProfile({ data, x: e.clientX, y: e.clientY })
  }

  const profileMessage = (name: string, _text: string) => {
    setProfile(null)
    // In the real app, this would create/navigate to a DM
    toast(`Opening DM with ${name}`)
  }

  // ── Shell chrome ──────────────────────────────────────────────────────────
  const shellProps = {
    appName: "Alook",
    inbox: (
      <InboxPopover
        feed={ctx.inboxFeed}
        mentions={ctx.mentions}
        onOpenItem={ctx.openInboxItem}
        onMarkAllRead={ctx.markAllInboxRead}
      />
    ),
    hasUnread: ctx.inboxFeed.some((f) => f.unread),
  }

  // ── Left sidebar rendering ────────────────────────────────────────────────
  const sidebar = (opts: { bordered?: boolean; noHeader?: boolean } = {}) =>
    isAtMe || view === "dm" ? (
      <DmSidebar
        dms={ctx.dms}
        activeDm={ctx.currentChannelId}
        onPickDm={enterDm}
        onShowFriends={() => ctx.setCurrentChannelId(null)}
        {...opts}
      />
    ) : (
      <ChannelSidebar {...channelProps} {...opts} />
    )

  // ── Dialogs ───────────────────────────────────────────────────────────────
  const dialogs = (
    <>
      <Dialog open={editingProfile} onOpenChange={(o) => { if (!o) setEditingProfile(false) }}>
        <DialogContent className="flex h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] sm:max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0" showCloseButton={false}>
          <UserSettings onClose={() => setEditingProfile(false)} aboutMe="" onSave={() => {}} onLogout={() => toast("Logged out")} />
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
        <MobileRail servers={railServers} folderServers={ctx.folderServers} onPick={() => setMobileZone("channels")} onHome={goHome} onServer={goServer} onAddServer={railProps.onCreateServer} onJoinServer={() => { /* Join is handled by the dialog inside MobileRail */ }} view={view} />
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
