"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { communityKeys } from "@/lib/query-keys"
import { userProfileQueryFn, PROFILE_STALE_TIME_MS } from "@/hooks/community/use-user-profile"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { AppSurface } from "@/components/ui/app-surface"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useBreakpoint } from "@/hooks/use-mobile"
import { Shell } from "./shell"
import { ServerRail } from "./server-rail"
import { UserBar } from "./user-bar"
import { markVoluntaryLeave, pickPostEjectDestination } from "./eject-server"
import { InboxPopover } from "./community-inbox-popover"
import { UserSettings } from "./edit-profile-dialog"
import { ProfileCard } from "./profile-card"
import { ImageLightbox } from "./image-lightbox"
import type { MobileZone, Profile, View } from "./_types"
import { signOut } from "@/lib/auth-client"
import { clearPersistedCache } from "@/lib/query-persister"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useCurrentUser, useSetCurrentUser } from "@/contexts/community/current-user"
import { useServers } from "@/hooks/community/use-servers"
import { useFolders } from "@/hooks/community/use-folders"
import { useFriends } from "@/hooks/community/use-friends"
import { useServerMembers } from "@/hooks/community/use-server-members"
import { useInboxUnreads, useInboxMentions } from "@/hooks/community/use-inbox"
import {
  useCreateServer,
  useJoinServer,
  useLeaveServer,
  useUploadServerIcon,
  useDeleteServerFolder,
  useReorderServers,
  useReorderFolders,
  useUpdateFolderItems,
  useCreateServerFolderWith,
  useCreateOrGetDm,
  useMarkAllInboxRead,
  useDeleteMention,
  useUpdateProfile,
  useSendDmMessage,
} from "@/hooks/community/mutations"

/**
 * Shared community shell — ServerRail on the left, sidebar column with the
 * caller's own nav, main content on the right, floating UserBar, plus the
 * mobile zone switch, ProfileCard, ImageLightbox, and the user-settings
 * dialog. Layouts wire their own sidebar and per-view state on top of this;
 * server-scoped dialogs (server settings) are slotted through `extraDialogs`.
 *
 * Mobile zone is owned by the caller so sidebar pick callbacks can flip to
 * "messages" without threading a ref through props. Layouts wire it to
 * `useCommunityStore.uiHandlers.goBackMobile` (registered on mount here) so
 * pages can swing back to nav without prop drilling.
 */
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
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const setCurrentUser = useSetCurrentUser()

  // Server list + folders drive the rail. Members + friends feed the profile
  // popover's mutual-server count when the user opens a member card.
  const serversQuery = useServers()
  const { servers } = serversQuery
  const { folders } = useFolders()
  const { friends } = useFriends()
  const currentServerId = useCommunityStore((s) => s.currentServerId)
  const membersHook = useServerMembers(currentServerId)
  const members = membersHook.members

  // Inbox pair — the shell reads both to drive the bell badge.
  const inboxUnreads = useInboxUnreads()
  const inboxMentions = useInboxMentions()
  const unreadFeed = inboxUnreads.servers
  const unreadDms = inboxUnreads.dms
  const mentions = inboxMentions.mentions
  const inboxLoading = inboxUnreads.isLoading || inboxMentions.isLoading

  // Mutations wired through the shell.
  const createServer = useCreateServer()
  const joinServer = useJoinServer()
  const leaveServer = useLeaveServer()
  const uploadServerIcon = useUploadServerIcon()
  const deleteFolder = useDeleteServerFolder()
  const reorderServers = useReorderServers()
  const reorderFolders = useReorderFolders()
  const updateFolderItems = useUpdateFolderItems()
  const createFolderWith = useCreateServerFolderWith()
  const createOrGetDm = useCreateOrGetDm()
  const sendDmMessage = useSendDmMessage()
  const markAllInboxRead = useMarkAllInboxRead()
  const deleteMention = useDeleteMention()
  const updateProfile = useUpdateProfile()

  const [editingProfile, setEditingProfile] = useState(false)
  const [profile, setProfile] = useState<{ data: Profile; x: number; y: number } | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  // Rail wiring — universal, since navigation is URL-driven and doesn't
  // depend on the current view.
  const folderServerIds = useMemo(() => {
    const s = new Set<string>()
    for (const f of folders) for (const srv of f.servers) s.add(srv.id)
    return s
  }, [folders])
  const railServers = useMemo(
    () =>
      servers
        .filter((s) => !folderServerIds.has(s.id))
        .map((s) => ({ ...s, active: s.id === activeServerId })),
    [servers, activeServerId, folderServerIds],
  )

  const onRailServerNavigate = useCallback(
    (id: string) => { router.push(`/community/channels/${id}`) },
    [router],
  )
  const onRailCreateServer = useCallback(
    async (name: string, icon?: File) => {
      try {
        const data = await createServer.mutateAsync({ name })
        const newId = data.server.id
        toast(`Server "${name}" created`)
        if (icon) uploadServerIcon.mutate({ serverId: newId, file: icon })
        router.push(`/community/channels/${newId}`)
      } catch {
        toast("Failed to create server")
      }
    },
    [createServer, uploadServerIcon, router],
  )
  const onRailJoinServer = useCallback(
    async (invite: string) => {
      try {
        const data = await joinServer.mutateAsync({ inviteCode: invite })
        toast("Joined server")
        router.push(`/community/channels/${data.serverId}`)
      } catch {
        toast("Failed to join server")
      }
    },
    [joinServer, router],
  )
  const onRailLeaveServer = useCallback(
    (id: string) => {
      // Mark BEFORE mutate — the WS `member.leave` fanout / servers-list
      // refetch can race the mutation callback and reach the layout's
      // eject effect first. Marker present → layout stays silent and
      // this button owns the "Left server" toast.
      markVoluntaryLeave(id)
      leaveServer.mutate(
        { serverId: id },
        {
          onSuccess: () => {
            toast("Left server")
            if (currentServerId === id) {
              router.replace(pickPostEjectDestination(servers, id))
            }
          },
          onError: () => toast("Failed to leave server"),
        },
      )
    },
    [leaveServer, currentServerId, router, servers],
  )
  const onRailOpenSettings = useCallback(
    (id?: string) => {
      if (id) router.push(`/community/channels/${id}?settings=1`)
    },
    [router],
  )
  const onRailOpenInvitePopover = useCallback(
    (id?: string) => {
      if (id) router.push(`/community/channels/${id}?invite=1`)
    },
    [router],
  )
  const onRailUngroupFolder = useCallback(
    (fId: string) => {
      deleteFolder.mutate(
        { folderId: fId },
        {
          onSuccess: () => toast("Group removed"),
          onError: () => toast("Failed to remove group"),
        },
      )
    },
    [deleteFolder],
  )
  const onRailReorderRail = useCallback(
    (ids: string[]) => {
      reorderServers.mutate(
        { serverIds: ids },
        { onError: () => toast("Failed to save server order") },
      )
    },
    [reorderServers],
  )
  const onRailReorderFolders = useCallback(
    (ids: string[]) => {
      reorderFolders.mutate(
        { folderIds: ids },
        { onError: () => toast("Failed to reorder groups") },
      )
    },
    [reorderFolders],
  )
  const onRailFolderItemsChange = useCallback(
    (fId: string, ids: string[]) => {
      updateFolderItems.mutate(
        { folderId: fId, serverIds: ids },
        { onError: () => toast("Failed to update group") },
      )
    },
    [updateFolderItems],
  )
  const onRailDragCreateFolder = useCallback(
    (a: string, b: string) => {
      createFolderWith.mutate(
        { serverIdA: a, serverIdB: b },
        { onError: () => toast("Failed to create group") },
      )
    },
    [createFolderWith],
  )

  const railProps = {
    servers: railServers,
    folders,
    activeServerId,
    serversLoading: serversQuery.isLoading,
    // `serversReady` gates the ServerRail auto-open — true only after the
    // very first fetch settles AND the query isn't refetching. Using
    // `isLoading` alone would let post-invalidate races (WS member.leave,
    // reconnect) with `servers=[]` re-fire the "Create a Server" dialog.
    serversReady: serversQuery.isFetched && !serversQuery.isFetching,
    setMobileZone,
    view,
    onHome: goHome,
    onServer: goServer,
    onServerNavigate: onRailServerNavigate,
    onCreateServer: onRailCreateServer,
    onJoinServer: onRailJoinServer,
    onLeaveServer: onRailLeaveServer,
    onOpenSettings: onRailOpenSettings,
    onOpenInvitePopover: onRailOpenInvitePopover,
    onUngroupFolder: onRailUngroupFolder,
    onReorderRail: onRailReorderRail,
    onReorderFolders: onRailReorderFolders,
    onFolderItemsChange: onRailFolderItemsChange,
    onDragCreateFolder: onRailDragCreateFolder,
  }

  // ProfileCard — resolves the target user from members / friends and
  // enriches with the profile API. Registered with the community store so
  // pages can trigger this from anywhere via `useCommunityStore.uiHandlers`.
  const openProfile = useCallback(
    (name: string, e: React.MouseEvent, discriminator?: string) => {
      const isSelf = name === currentUser.name
      if (isSelf) {
        const data: Profile = {
          name: currentUser.name,
          discriminator: currentUser.discriminator,
          avatar: currentUser.avatar || currentUser.name.charAt(0).toUpperCase(),
          role: "You",
          about: currentUser.aboutMe ?? "",
          mutual: 0,
          tags: [],
        }
        setProfile({ data, x: e.clientX, y: e.clientY })
        return
      }
      // A `#0042`-tagged mention pill disambiguates an exact same-named
      // member/friend; without a tag (author-name/avatar clicks, plain
      // `@name` mentions), fall back to the first name match as before.
      const member = (discriminator
        ? (members ?? []).find((m) => m.name === name && m.discriminator === discriminator)
        ?? (friends ?? []).find((f) => f.name === name && f.discriminator === discriminator)
        : undefined)
        ?? (members ?? []).find((m) => m.name === name)
        ?? (friends ?? []).find((f) => f.name === name)
      const role: string = member && "role" in member ? (member as { role: string }).role : "member"
      const about: string = member && "sub" in member && (member as { sub: string }).sub ? (member as { sub: string }).sub : ""
      const displayRole = role.charAt(0).toUpperCase() + role.slice(1)
      const data: Profile = {
        name,
        // discriminator is undefined until the /profile fetch below hydrates it.
        avatar: member?.avatar ?? name.charAt(0).toUpperCase(),
        role: displayRole,
        about,
        mutual: 0,
        tags: role !== "member" ? [displayRole] : [],
      }
      setProfile({ data, x: e.clientX, y: e.clientY })
      const userId = member && "userId" in member ? (member as { userId: string }).userId : member?.id
      if (userId) {
        // Cached under `communityKeys.profile(userId)` — a re-click on the
        // same person within `PROFILE_STALE_TIME_MS` resolves from memory
        // instead of re-hitting the network (see plans/profile-card-memory-cache.md).
        queryClient
          .fetchQuery({
            queryKey: communityKeys.profile(userId),
            queryFn: userProfileQueryFn(userId),
            staleTime: PROFILE_STALE_TIME_MS,
          })
          .then((p) => {
            setProfile((prev) =>
              prev
                ? {
                  ...prev,
                  data: {
                    ...prev.data,
                    about: p.aboutMe ?? prev.data.about,
                    mutual: p.mutualServers ?? 0,
                    discriminator: p.discriminator ?? prev.data.discriminator,
                  },
                }
                : prev,
            )
          })
          .catch(() => { })
      }
    },
    [currentUser, members, friends, queryClient],
  )

  const previewImage = useCallback((url: string) => setPreview(url), [])
  const goBackMobile = useCallback(() => setMobileZone("nav"), [setMobileZone])
  useEffect(() => {
    useCommunityStore.getState().registerUiHandlers({
      previewImage,
      openProfile,
      goBackMobile,
    })
  }, [previewImage, openProfile, goBackMobile])

  const profileMessage = async (name: string, text: string) => {
    setProfile(null)
    const member = members.find((m) => m.name === name)
    const friend = friends.find((f) => f.name === name)
    const targetUserId = member?.userId ?? friend?.userId
    if (!targetUserId) {
      toast(`Could not find user ${name}`)
      return
    }
    let dmId: string
    try {
      const data = await createOrGetDm.mutateAsync({ userId: targetUserId })
      dmId = data.conversation.id
    } catch {
      toast("Failed to open DM")
      return
    }
    // Await the send BEFORE navigating so the server row exists by the time
    // the DM page mounts and fires its initial `GET /messages`. Otherwise
    // the fresh-mount fetch races the send: it returns [], overwrites the
    // optimistic cache, and the first message silently vanishes. Failure
    // surfaces as a toast + `failed: true` pill; we still navigate so the
    // user has the composer to retry.
    const trimmed = text.trim()
    if (trimmed) {
      try {
        await sendDmMessage.mutateAsync({
          dmId,
          content: trimmed,
          author: {
            id: currentUser.id,
            name: currentUser.name,
            avatar: currentUser.avatar,
          },
        })
      } catch {
        toast("Failed to send message")
      }
    }
    router.push(`/community/me/${dmId}`)
  }

  const openServerChannel = useCallback(
    (sid: string, cid: string) => {
      // #3: no eager mark-read on inbox → channel navigation. The channel's
      // IntersectionObserver watermark advances the pointer as the user
      // actually reads. If they open the channel and don't scroll to the
      // new messages, the pointer correctly stays put.
      router.push(`/community/channels/${sid}/${cid}`)
    },
    [router],
  )

  const openInboxDm = useCallback(
    (dmId: string) => {
      // Mirrors the DM sidebar's `enterDm` (see app/community/me/layout.tsx):
      // client-only optimistic clear on `communityKeys.dms()` — no eager
      // mark-read PUT. Eagerly aligning the read pointer to the tail here
      // would resolve the DM's read-state snapshot at tail on mount and
      // suppress the NEW divider. The DM page's IntersectionObserver
      // (`useDmWatermark`) is authoritative for advancing the server pointer.
      queryClient.setQueryData(
        communityKeys.dms(),
        (prev: { conversations: { id: string; unread?: boolean }[] } | undefined) =>
          prev
            ? { ...prev, conversations: prev.conversations.map((d) => (d.id === dmId ? { ...d, unread: false } : d)) }
            : prev,
      )
      router.push(`/community/me/${dmId}`)
    },
    [router, queryClient],
  )

  const inboxElement = (
    <InboxPopover
      unreads={unreadFeed}
      unreadDms={unreadDms}
      mentions={mentions}
      loading={inboxLoading}
      onOpenChannel={openServerChannel}
      onOpenDm={openInboxDm}
      onOpenMention={(mention) => {
        if (mention.serverId && mention.channelId) openServerChannel(mention.serverId, mention.channelId)
      }}
      onMarkAllRead={() => { markAllInboxRead.mutate() }}
      onDeleteMention={(id) => deleteMention.mutate({ mentionId: id })}
    />
  )
  const inboxHasUnread =
    (unreadFeed?.length ?? 0) > 0 || (unreadDms?.length ?? 0) > 0 || (mentions?.length ?? 0) > 0

  const userSettingsDialog = (
    <Dialog open={editingProfile} onOpenChange={(o) => { if (!o) setEditingProfile(false) }}>
      <DialogContent className="flex h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] sm:max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0" showCloseButton={false}>
        <UserSettings
          onClose={() => setEditingProfile(false)}
          userId={currentUser.id}
          userName={currentUser.name}
          aboutMe={currentUser.aboutMe ?? ""}
          onSave={async (data) => {
            try {
              await updateProfile.mutateAsync(data)
              setCurrentUser((u) => ({
                ...u,
                ...(data.name ? { name: data.name } : {}),
                ...(data.aboutMe !== undefined ? { aboutMe: data.aboutMe } : {}),
              }))
            } catch { toast("Failed to save profile") }
          }}
          onLogout={async () => {
            // Clear community-local state (timers, subscription, presence)
            // before the auth cookie clears so no orphan timers fire after
            // the user is gone. `useCommunityStore.reset()` also flushes any
            // pending mark-reads so the last-read pointer isn't stranded in
            // the debounce window — covers every sign-out path uniformly.
            useCommunityStore.getState().reset()
            useCommunityWsStore.getState().reset()
            // Drop the persisted IDB blob so the next user on this machine
            // doesn't see the previous session's cached message rows.
            await clearPersistedCache(currentUser.id).catch(() => {})
            await signOut()
            router.push("/sign-in")
          }}
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
            <UserBar user={{ name: currentUser.name, avatar: currentUser.avatar }} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} inbox={inboxElement} hasUnread={inboxHasUnread} />
          </div>
        </div>
        {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === currentUser.name} />}
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
            <UserBar user={{ name: currentUser.name, avatar: currentUser.avatar }} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} inbox={inboxElement} hasUnread={inboxHasUnread} />
          </div>
        </>
      )}
      {mobileZone === "messages" && (
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          {children}
        </div>
      )}
      {profile && <ProfileCard data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={profile.data.name === currentUser.name} />}
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
      {userSettingsDialog}
      {extraDialogs}
    </Shell>
  )
}
