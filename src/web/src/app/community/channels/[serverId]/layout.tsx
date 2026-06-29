"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useParams, useRouter, useSearchParams, useSelectedLayoutSegment } from "next/navigation"
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

export default function ServerLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ serverId: string }>()
  const searchParams = useSearchParams()
  const channelSegment = useSelectedLayoutSegment()
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
  const [mobileZone, setMobileZone] = useState<MobileZone>(() => channelSegment ? "messages" : "channels")
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
  const myMember = ctx.members.find((m) => m.userId === ctx.currentUser.id)
  const isAdmin = canManageServer(myMember?.role)
  const channelProps = {
    tree: channelTree,
    serverName: ctx.currentServer?.name ?? "",
    activeChannel: ctx.currentChannelMeta?.parentChannelId ?? ctx.currentChannelId ?? "",
    isAdmin,
    currentUserId: ctx.currentUser.id,
    setActiveChannel: (id: string) => {
      router.push(`/community/channels/${serverId}/${id}`)
      ctx.setCurrentChannelId(id)
      ctx.markChannelRead(id)
      channelTree.markRead(id)
      if (bp === "mobile") setMobileZone("messages")
    },
    onOpenSettings: isAdmin ? () => { setServerSettingsOpen(true) } : undefined,
    onBlockedCreate: () => toast("Only admins can create channels in a private category"),
    mutedChannels: Object.fromEntries(
      Object.entries(ctx.channelNotif).map(([k, v]) => [k, v === "Nothing"])
    ),
    onCreateChannel: (categoryId: string, name: string, type: ChannelType) => {
      ctx.createChannel(serverId, categoryId, name, type)
    },
    onCreateCategory: (name: string, opts?: { private?: boolean }) => {
      ctx.createCategory(serverId, name, opts)
    },
    onRenameChannel: async (channelId: string, name: string) => {
      try {
        await apiFetch(`/api/community/channels/${channelId}`, {
          method: "PATCH",
          body: JSON.stringify({ name }),
        })
      } catch (e: any) {
        toast(e?.message || "Failed to rename channel")
      }
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

  // ── Left sidebar rendering ────────────────────────────────────────────────
  const sidebar = (opts: { noHeader?: boolean } = {}) =>
    isAtMe || view === "dm" ? (
      <DmSidebar
        dms={ctx.dms ?? []}
        activeDm={ctx.currentChannelId}
        onPickDm={enterDm}
        onShowFriends={() => ctx.setCurrentChannelId(null)}
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
  const leftPanelRef = useRef<HTMLDivElement>(null)
  const [userBarRight, setUserBarRight] = useState(0)
  useEffect(() => {
    const el = leftPanelRef.current
    if (!el) return
    const update = () => { const rect = el.getBoundingClientRect(); setUserBarRight(window.innerWidth - rect.right) }
    update()
    const ro = new ResizeObserver(() => update())
    ro.observe(el)
    return () => ro.disconnect()
  }, [bp])

  if (bp === "desktop") {
    return (
      <Shell>
        <ServerRail {...railProps} bottomInset={52} />
        <div className="flex-1 flex flex-col min-w-0 pt-2 pr-2 pb-2">
          <AppSurface>
            <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
              <ResizablePanel defaultSize="24%" minSize={160} maxSize={360} className="flex flex-col border-r border-border/40">
                <div ref={leftPanelRef} className="flex min-h-0 flex-1 flex-col pb-12">
                  {sidebar()}
                </div>
              </ResizablePanel>
              <ResizableHandle className="bg-transparent" />
              <ResizablePanel defaultSize="76%" className="flex min-w-0 flex-col bg-background">
                {children}
              </ResizablePanel>
            </ResizablePanelGroup>
          </AppSurface>
        </div>
        {userBarRight > 0 && (
          <UserBar
            user={{ name: ctx.currentUser.name, avatar: ctx.currentUser.avatar }}
            floating
            rightInset={userBarRight}
            onOpenProfile={openProfile}
            onEditProfile={() => setEditingProfile(true)}
            inbox={inboxElement}
            hasUnread={inboxHasUnread}
          />
        )}
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
        <div className="flex min-h-0 flex-1 flex-col bg-card">
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
