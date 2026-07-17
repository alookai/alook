"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { userProfileQueryFn, PROFILE_STALE_TIME_MS } from "@/hooks/community/use-user-profile"
import { useDefaultLayout } from "react-resizable-panels"
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
import { ImageCropDialog } from "./image-crop-dialog"
import { validateIconSourceFile } from "@/lib/community/image-crop"
import type { MobileZone, Profile, View } from "./_types"
import { resolveProfileTarget } from "./profile-lookup"
import { resolveProfilePresence } from "@/lib/community/presence"
import { avatarInitial } from "@/lib/community/avatar"
import { signOut } from "@/lib/auth-client"
import { clearPersistedCache } from "@/lib/query-persister"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore, useOnlineUserIds } from "@/stores/community/ws"
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
  useUploadUserAvatar,
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
  const onlineUserIds = useOnlineUserIds()

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
  const uploadUserAvatar = useUploadUserAvatar()

  const [editingProfile, setEditingProfile] = useState(false)
  const [profile, setProfile] = useState<{
    data: Profile
    x: number
    y: number
    // First-paint seed for the status pill — used only until `userStatuses`
    // has an overlay entry for this user. See profile-card.tsx for the merge
    // rule (overlay wins, seed is fallback).
    initialStatusEmoji: string | null
    initialStatusText: string | null
  } | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [pendingAvatarCrop, setPendingAvatarCrop] = useState<{ src: string; fileName: string } | null>(null)

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
    (id: string) => { router.push(`/c/channels/${id}`) },
    [router],
  )
  const onRailCreateServer = useCallback(
    async (name: string, icon?: File) => {
      try {
        const data = await createServer.mutateAsync({ name })
        const newId = data.server.id
        toast(`Server "${name}" created`)
        if (icon) {
          uploadServerIcon.mutate(
            { serverId: newId, file: icon },
            { onError: (e) => toastApiError(e, "Server created, but the icon failed to upload") },
          )
        }
        router.push(`/c/channels/${newId}`)
      } catch (e) {
        toastApiError(e, "Failed to create server")
      }
    },
    [createServer, uploadServerIcon, router],
  )
  const onRailJoinServer = useCallback(
    async (invite: string) => {
      try {
        const data = await joinServer.mutateAsync({ inviteCode: invite })
        toast("Joined server")
        router.push(`/c/channels/${data.serverId}`)
      } catch (e) {
        toastApiError(e, "Failed to join server")
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
          onError: (e) => toastApiError(e, "Failed to leave server"),
        },
      )
    },
    [leaveServer, currentServerId, router, servers],
  )
  const onRailOpenSettings = useCallback(
    (id?: string) => {
      if (id) router.push(`/c/channels/${id}?settings=1`)
    },
    [router],
  )
  const onRailOpenInvitePopover = useCallback(
    (id?: string) => {
      if (id) router.push(`/c/channels/${id}?invite=1`)
    },
    [router],
  )
  const onRailUngroupFolder = useCallback(
    (fId: string) => {
      deleteFolder.mutate(
        { folderId: fId },
        {
          onSuccess: () => toast("Group removed"),
          onError: (e) => toastApiError(e, "Failed to remove group"),
        },
      )
    },
    [deleteFolder],
  )
  const onRailReorderRail = useCallback(
    (ids: string[]) => {
      reorderServers.mutate(
        { serverIds: ids },
        { onError: (e) => toastApiError(e, "Failed to save server order") },
      )
    },
    [reorderServers],
  )
  const onRailReorderFolders = useCallback(
    (ids: string[]) => {
      reorderFolders.mutate(
        { folderIds: ids },
        { onError: (e) => toastApiError(e, "Failed to reorder groups") },
      )
    },
    [reorderFolders],
  )
  const onRailFolderItemsChange = useCallback(
    (fId: string, ids: string[]) => {
      updateFolderItems.mutate(
        { folderId: fId, serverIds: ids },
        { onError: (e) => toastApiError(e, "Failed to update group") },
      )
    },
    [updateFolderItems],
  )
  const onRailDragCreateFolder = useCallback(
    (a: string, b: string) => {
      createFolderWith.mutate(
        { serverIdA: a, serverIdB: b },
        { onError: (e) => toastApiError(e, "Failed to create group") },
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
    (name: string, e: React.MouseEvent, discriminator?: string, targetUserId?: string) => {
      const isSelf = !!targetUserId && targetUserId === currentUser.id
      if (isSelf) {
        const data: Profile = {
          name: currentUser.name,
          userId: currentUser.id,
          discriminator: currentUser.discriminator,
          avatar: currentUser.avatar || avatarInitial(currentUser.name),
          role: "You",
          about: currentUser.aboutMe ?? "",
          mutual: 0,
          presence: resolveProfilePresence(true, undefined, onlineUserIds),
        }
        setProfile({
          data,
          x: e.clientX,
          y: e.clientY,
          initialStatusEmoji: currentUser.statusEmoji ?? null,
          initialStatusText: currentUser.statusText ?? null,
        })
        return
      }
      const member = resolveProfileTarget(members, friends, { name, discriminator, userId: targetUserId })
      const role: string = member && "role" in member ? (member as { role: string }).role : "member"
      const about: string = member && "sub" in member && (member as { sub: string }).sub ? (member as { sub: string }).sub : ""
      const displayRole = role.charAt(0).toUpperCase() + role.slice(1)
      // Hoisted above `data` (was previously computed after `setProfile`,
      // only for the async fetch below) so the same value can also feed
      // `resolveProfilePresence`.
      const userId = member && "userId" in member ? (member as { userId: string }).userId : member?.id
      const data: Profile = {
        name,
        userId,
        // discriminator is undefined until the /profile fetch below hydrates it.
        avatar: member?.avatar ?? avatarInitial(name),
        role: displayRole,
        about,
        mutual: 0,
        presence: resolveProfilePresence(false, userId, onlineUserIds),
      }
      setProfile({
        data,
        x: e.clientX,
        y: e.clientY,
        initialStatusEmoji: member?.statusEmoji ?? null,
        initialStatusText: member?.statusText ?? null,
      })
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
            // Refresh THIS card's seed only — never write to the WS overlay
            // from a REST snapshot. `communityKeys.profile(userId)` is cached
            // for 5 min, so a re-open can resolve from stale cache; the WS
            // overlay is meant to be the freshest source (community:status.update
            // events keep it live). Writing REST → overlay would let a stale
            // cache clobber a live WS value, and every other consumer
            // (member list, friends list, UserBar) that subscribes to the
            // overlay would visibly regress. Overlay stays write-only from
            // the WS handler + self-mutation paths.
            // Status fields are assigned directly (no `??` fallback) — the
            // REST route always populates both, and a freshly-cleared status
            // must overwrite a stale member-row seed instead of getting
            // masked by it.
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
                  initialStatusEmoji: p.statusEmoji,
                  initialStatusText: p.statusText,
                }
                : prev,
            )
          })
          .catch((e) => toastApiError(e, "Failed to load profile"))
      }
    },
    [currentUser, members, friends, queryClient, onlineUserIds],
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

  // Inline self-status save from the `ProfileCard` header (see status-editor.tsx).
  // Mirrors `userSettingsDialog`'s onSave status branch exactly — both save
  // paths must independently apply the same local WS-store write, since self
  // isn't in their own fan-out audience (see plans/profile-card-status-overlay.md).
  // The card and every other consumer subscribe to `userStatuses`, so writing
  // to the store is enough — no need to mirror the value onto `Profile`.
  const updateOwnStatus = async (statusEmoji: string | null, statusText: string | null) => {
    try {
      await updateProfile.mutateAsync({ statusEmoji, statusText })
      setCurrentUser((u) => ({ ...u, statusEmoji, statusText }))
      useCommunityWsStore.getState().setUserStatus(currentUser.id, statusEmoji, statusText)
    } catch (e) {
      toastApiError(e, "Failed to update status")
    }
  }

  const profileMessage = async (userId: string, text: string) => {
    if (!userId) {
      toast("Could not find user")
      return
    }
    let dmId: string
    try {
      const data = await createOrGetDm.mutateAsync({ userId })
      dmId = data.conversation.id
    } catch (e) {
      toastApiError(e, "Failed to open DM")
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
      } catch (e) {
        toastApiError(e, "Failed to send message")
      }
    }
    router.push(`/c/me/${dmId}`)
  }

  const openServerChannel = useCallback(
    (sid: string, cid: string) => {
      // No PUT here — the channel/thread page's `useEagerChannelRead` fires the
      // mark-read on mount, AFTER its read-state snapshot latches, so the NEW
      // divider still anchors to the pre-open pointer. Navigating is enough.
      router.push(`/c/channels/${sid}/${cid}`)
    },
    [router],
  )

  const openInboxDm = useCallback(
    (dmId: string) => {
      // Optimistic clear on `communityKeys.dms()` so the sidebar updates
      // instantly. The real mark-read is owned by the DM page's
      // `useEagerDmRead` on mount (snapshot latches first → NEW divider stays
      // anchored), and `useDmWatermark` continues to advance the pointer as
      // the viewer scrolls.
      queryClient.setQueryData(
        communityKeys.dms(),
        (prev: { conversations: { id: string; unread?: boolean }[] } | undefined) =>
          prev
            ? { ...prev, conversations: prev.conversations.map((d) => (d.id === dmId ? { ...d, unread: false } : d)) }
            : prev,
      )
      router.push(`/c/me/${dmId}`)
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
      <DialogContent className="flex h-[calc(100vh-4rem)] max-h-180 w-[calc(100vw-4rem)] sm:max-w-4xl flex-col gap-0 overflow-hidden rounded-xl p-0" showCloseButton={false}>
        <UserSettings
          onClose={() => setEditingProfile(false)}
          userId={currentUser.id}
          userName={currentUser.name}
          aboutMe={currentUser.aboutMe ?? ""}
          avatar={currentUser.avatar}
          statusEmoji={currentUser.statusEmoji}
          statusText={currentUser.statusText}
          onUploadAvatar={() => {
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
              setPendingAvatarCrop({ src: URL.createObjectURL(f), fileName: f.name })
            }
            input.click()
          }}
          onSave={async (data) => {
            try {
              await updateProfile.mutateAsync(data)
              setCurrentUser((u) => ({
                ...u,
                ...(data.name ? { name: data.name } : {}),
                ...(data.aboutMe !== undefined ? { aboutMe: data.aboutMe } : {}),
                ...(data.statusEmoji !== undefined ? { statusEmoji: data.statusEmoji } : {}),
                ...(data.statusText !== undefined ? { statusText: data.statusText } : {}),
              }))
              // Self is not in their own WS fan-out audience (co-members/friends
              // means *other* people) — apply the same store write locally so
              // the viewer's own rows (member list, UserBar) update immediately.
              if (data.statusEmoji !== undefined || data.statusText !== undefined) {
                useCommunityWsStore.getState().setUserStatus(
                  currentUser.id,
                  data.statusEmoji ?? null,
                  data.statusText ?? null,
                )
              }
            } catch (e) { toastApiError(e, "Failed to save profile") }
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
            await clearPersistedCache(currentUser.id).catch(() => { })
            await signOut()
            router.push("/sign-in")
          }}
        />
      </DialogContent>
    </Dialog>
  )

  const avatarCropDialog = pendingAvatarCrop && (
    <ImageCropDialog
      imageSrc={pendingAvatarCrop.src}
      originalFileName={pendingAvatarCrop.fileName}
      maskShape="circle"
      onCropped={(file) => {
        uploadUserAvatar.mutate({ file }, {
          onSuccess: (data) => {
            setCurrentUser((u) => ({ ...u, avatar: `${data.url}?t=${Date.now()}` }))
            toast("Avatar updated")
          },
          onError: (e) => toastApiError(e, "Failed to upload avatar"),
        })
        URL.revokeObjectURL(pendingAvatarCrop.src)
        setPendingAvatarCrop(null)
      }}
      onCancel={() => {
        URL.revokeObjectURL(pendingAvatarCrop.src)
        setPendingAvatarCrop(null)
      }}
    />
  )

  // `ShellFrame` mounts separately in `channels/layout.tsx` and `me/layout.tsx`
  // — navigating server ↔ DMs unmounts one and mounts the other, which would
  // otherwise reset the panel to `defaultSize` every time. A single shared
  // `id` (not scoped to `view`/`activeServerId`) persists one width across
  // both instances, in localStorage, so it also survives full page reloads.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "community-shell" })
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
            <ResizablePanelGroup
              id="community-shell"
              orientation="horizontal"
              className="min-h-0 flex-1"
              defaultLayout={defaultLayout}
              onLayoutChanged={onLayoutChanged}
            >
              <ResizablePanel id="sidebar" defaultSize="24%" minSize={160} maxSize={360} className="flex flex-col pb-14 bg-sidebar">
                <div ref={sidebarPanelRef} className="flex min-h-0 flex-1 flex-col">
                  {sidebar()}
                </div>
              </ResizablePanel>
              <ResizableHandle className="bg-transparent" />
              <ResizablePanel id="main" defaultSize="76%" className="flex min-w-0 flex-col bg-background">
                {children}
              </ResizablePanel>
            </ResizablePanelGroup>
          </AppSurface>
          <div className="absolute bottom-0 left-0 z-10" style={{ width: sidebarW + 56, marginLeft: -56 }}>
            <UserBar user={{ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar }} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} inbox={inboxElement} hasUnread={inboxHasUnread} />
          </div>
        </div>
        {profile && <ProfileCard key={`${profile.data.userId ?? profile.data.name}:${profile.x}:${profile.y}`} data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={!!profile.data.userId && profile.data.userId === currentUser.id} onUpdateStatus={updateOwnStatus} initialStatusEmoji={profile.initialStatusEmoji} initialStatusText={profile.initialStatusText} />}
        {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
        {userSettingsDialog}
        {avatarCropDialog}
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
            <UserBar user={{ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar }} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} inbox={inboxElement} hasUnread={inboxHasUnread} />
          </div>
        </>
      )}
      {mobileZone === "messages" && (
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          {children}
        </div>
      )}
      {profile && <ProfileCard key={`${profile.data.userId ?? profile.data.name}:${profile.x}:${profile.y}`} data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={!!profile.data.userId && profile.data.userId === currentUser.id} onUpdateStatus={updateOwnStatus} />}
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
      {userSettingsDialog}
      {avatarCropDialog}
      {extraDialogs}
    </Shell>
  )
}
