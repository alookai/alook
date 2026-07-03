"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { AppSurface } from "@/components/ui/app-surface"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useCommunity } from "@/contexts/community/context"
import { useBreakpoint } from "@/hooks/use-mobile"
import { Shell } from "./shell"
import { ServerRail } from "./server-rail"
import { UserBar } from "./user-bar"
import { InboxPopover } from "./community-inbox-popover"
import { UserSettings } from "./edit-profile-dialog"
import { ProfileCard } from "./profile-card"
import { ImageLightbox } from "./image-lightbox"
import type { MobileZone, Profile, View } from "./_types"
import { signOut } from "@/lib/auth-client"

// Shared community shell — ServerRail on the left, sidebar column with the
// caller's own nav, main content on the right, floating UserBar, plus the
// mobile zone switch, ProfileCard, ImageLightbox, and the user-settings
// dialog. Layouts wire their own sidebar and per-view state on top of this;
// server-scoped dialogs (server settings) are slotted through `extraDialogs`.
//
// Mobile zone is owned by the caller so sidebar pick callbacks can flip to
// "messages" without threading a ref through props. Layouts wire it to
// `ctx.goBackMobile` (registered on mount) so pages can swing back to nav.
export function ShellFrame({
  view,
  activeServerId,
  mobileZone,
  setMobileZone,
  sidebar,
  children,
  extraDialogs,
  goHome,
  goServer,
}: {
  view: View
  activeServerId: string | undefined
  mobileZone: MobileZone
  setMobileZone: (z: MobileZone) => void
  sidebar: (opts?: { noHeader?: boolean }) => ReactNode
  children: ReactNode
  extraDialogs?: ReactNode
  goHome: () => void
  goServer: () => void
}) {
  const router = useRouter()
  const bp = useBreakpoint()
  const ctx = useCommunity()

  const [editingProfile, setEditingProfile] = useState(false)
  const [profile, setProfile] = useState<{ data: Profile; x: number; y: number } | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  // Rail wiring — universal, since navigation is URL-driven and doesn't
  // depend on the current view.
  const folderServerIds = useMemo(() => {
    const s = new Set<string>()
    for (const f of ctx.folders) for (const srv of f.servers) s.add(srv.id)
    return s
  }, [ctx.folders])
  const railServers = useMemo(
    () => ctx.servers.filter((s) => !folderServerIds.has(s.id)).map((s) => ({ ...s, active: s.id === activeServerId })),
    [ctx.servers, activeServerId, folderServerIds],
  )

  const onRailServerNavigate = useCallback((id: string) => { router.push(`/community/channels/${id}`) }, [router])
  const onRailCreateServer = useCallback(async (name: string, icon?: File) => {
    const newId = await ctx.createServer(name)
    if (newId) {
      if (icon) ctx.uploadServerIcon(newId, icon)
      router.push(`/community/channels/${newId}`)
    }
  }, [ctx.createServer, ctx.uploadServerIcon, router]) // eslint-disable-line react-hooks/exhaustive-deps
  const onRailJoinServer = useCallback(async (invite: string) => {
    const newId = await ctx.joinServer(invite)
    if (newId) router.push(`/community/channels/${newId}`)
  }, [ctx.joinServer, router]) // eslint-disable-line react-hooks/exhaustive-deps
  const onRailLeaveServer = useCallback((id: string) => { ctx.leaveServer(id) }, [ctx.leaveServer]) // eslint-disable-line react-hooks/exhaustive-deps
  const onRailOpenSettings = useCallback((id?: string) => {
    if (id) router.push(`/community/channels/${id}?settings=1`)
  }, [router])
  const onRailUngroupFolder = useCallback((fId: string) => { ctx.deleteServerFolder(fId) }, [ctx.deleteServerFolder]) // eslint-disable-line react-hooks/exhaustive-deps
  const onRailReorderRail = useCallback((ids: string[]) => { ctx.reorderServers(ids) }, [ctx.reorderServers]) // eslint-disable-line react-hooks/exhaustive-deps
  const onRailReorderFolders = useCallback((ids: string[]) => { ctx.reorderFolders(ids) }, [ctx.reorderFolders]) // eslint-disable-line react-hooks/exhaustive-deps
  const onRailFolderItemsChange = useCallback((fId: string, ids: string[]) => { ctx.updateFolderItems(fId, ids) }, [ctx.updateFolderItems]) // eslint-disable-line react-hooks/exhaustive-deps
  const onRailDragCreateFolder = useCallback((a: string, b: string) => { ctx.createServerFolderWith(a, b) }, [ctx.createServerFolderWith]) // eslint-disable-line react-hooks/exhaustive-deps

  const railProps = {
    servers: railServers,
    folders: ctx.folders,
    activeServerId,
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
  }

  // ProfileCard — resolves the target user from members / friends and
  // enriches with the profile API. Registered with the community context
  // so pages can trigger this from anywhere via ctx.openProfile().
  const openProfile = useCallback((name: string, e: React.MouseEvent) => {
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
  }, [ctx.currentUser, ctx.members, ctx.friends]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    ctx.registerUiHandlers({
      previewImage: (url) => setPreview(url),
      openProfile,
      goBackMobile: () => setMobileZone("nav"),
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
    if (dmId) router.push(`/community/me/${dmId}`)
  }

  const openServerChannel = useCallback((sid: string, cid: string) => {
    router.push(`/community/channels/${sid}/${cid}`)
    ctx.markChannelRead(cid)
  }, [router, ctx.markChannelRead]) // eslint-disable-line react-hooks/exhaustive-deps

  const inboxElement = (
    <InboxPopover
      forYou={ctx.forYouFeed}
      unreads={ctx.unreadFeed}
      mentions={ctx.mentions}
      loading={ctx.inboxLoading}
      onOpenEvent={(e) => openServerChannel(e.serverId, e.channelId)}
      onOpenChannel={openServerChannel}
      onOpenMention={(mention) => {
        if (mention.serverId && mention.channelId) openServerChannel(mention.serverId, mention.channelId)
      }}
      onMarkAllRead={() => { void ctx.markAllInboxRead() }}
      onDismissEvent={(eventKey) => { void ctx.dismissForYouEvent(eventKey) }}
      onDeleteMention={ctx.deleteMention}
    />
  )
  const inboxHasUnread =
    (ctx.forYouFeed?.length ?? 0) > 0 ||
    (ctx.unreadFeed?.length ?? 0) > 0 ||
    (ctx.mentions?.length ?? 0) > 0

  const userSettingsDialog = (
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
  )

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

  if (bp === "desktop") {
    return (
      <Shell>
        <ServerRail {...railProps} bottomInset={60} />
        <div className="relative flex-1 flex flex-col min-w-0 pt-2">
          <AppSurface className="rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none ring-0 border-l border-t border-border/40 shadow-none">
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
          <div className="absolute bottom-0 left-0 z-10" style={{ width: sidebarW + 56, marginLeft: -56 }}>
            <UserBar user={{ name: ctx.currentUser.name, avatar: ctx.currentUser.avatar }} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} inbox={inboxElement} hasUnread={inboxHasUnread} />
          </div>
        </div>
        {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === ctx.currentUser.name} />}
        {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
        {userSettingsDialog}
        {extraDialogs}
      </Shell>
    )
  }

  return (
    <Shell>
      {mobileZone === "nav" && (
        <>
          <ServerRail {...railProps} bottomInset={60} />
          <div className="flex min-h-0 flex-1 flex-col bg-sidebar">
            <div className="flex min-h-0 flex-1">{sidebar({ noHeader: false })}</div>
            <UserBar user={{ name: ctx.currentUser.name, avatar: ctx.currentUser.avatar }} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} inbox={inboxElement} hasUnread={inboxHasUnread} />
          </div>
        </>
      )}
      {mobileZone === "messages" && (
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          {children}
        </div>
      )}
      {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === ctx.currentUser.name} />}
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
      {userSettingsDialog}
      {extraDialogs}
    </Shell>
  )
}
