"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { markSwitch } from "@/lib/perf/switch-mark"
import { userProfileQueryFn, PROFILE_STALE_TIME_MS } from "@/hooks/community/use-user-profile"
import { useDefaultLayout } from "react-resizable-panels"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { AppSurface } from "@/components/ui/app-surface"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useBreakpoint } from "@/hooks/use-mobile"
import { Shell } from "./shell"
import {
  COMMUNITY_RAIL_WIDTH,
  desktopUserBarOverlayWidth,
} from "./shell-frame-geometry"
import { ServerRail } from "./server-rail"
import { resolveServerRailOverlayAction } from "./server-rail-actions"
import { UserBar } from "./user-bar"
import { markVoluntaryLeave, pickPostEjectDestination } from "./eject-server"
import { InboxPopover } from "./community-inbox-popover"
import { UserSettings } from "./edit-profile-dialog"
import { ProfileCard } from "./profile-card"
import { ImageLightbox } from "./image-lightbox"
import { ImageCropDialog } from "./image-crop-dialog"
import { validateIconSourceFile } from "@/lib/community/image-crop"
import type { ImagePreview, Marked, MobileZone, Profile, View } from "./_types"
import { resolveProfileTarget, buildSelfProfile } from "./profile-lookup"
import { resolveProfilePresence } from "@/lib/community/presence"
import { avatarInitial } from "@/lib/community/avatar"
import { signOut } from "@/lib/auth-client"
import { clearPersistedCache } from "@/lib/query-persister"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore, useOnlineUserIds } from "@/stores/community/ws"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { useCurrentUser, useSetCurrentUser } from "@/contexts/community/current-user"
import { useServers } from "@/hooks/community/use-servers"
import { useFolders } from "@/hooks/community/use-folders"
import { useFriends } from "@/hooks/community/use-friends"
import { useServerMembers } from "@/hooks/community/use-server-members"
import { useInboxUnreads, useInboxMentions, useInboxMarked } from "@/hooks/community/use-inbox"
import { useInboxAutoCollapse } from "@/hooks/community/use-inbox-auto-collapse"
import { useCommunityOnboarding } from "@/lib/community-onboarding"
import {
  useCreateServer,
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
  useUnmarkMessage,
  useUpdateProfile,
  useReadForumThreadFromInbox,
  useUploadUserAvatar,
} from "@/hooks/community/mutations"
import { useDmMessageSender } from "@/hooks/community/use-dm-message-sender"

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
  onOpenActiveServerSettings,
  onOpenActiveServerInvite,
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
  onOpenActiveServerSettings?: () => void
  onOpenActiveServerInvite?: () => void
  goHome: () => void
  goServer: () => void
}) {
  const router = useRouter()
  const bp = useBreakpoint()
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const setCurrentUser = useSetCurrentUser()
  const onlineUserIds = useOnlineUserIds()
  const onboardingState = useCommunityOnboarding()

  useEffect(() => {
    if (onboardingState?.status === "active") {
      setMobileZone(onboardingState.stage === "server" ? "nav" : "messages")
    }
  }, [onboardingState, setMobileZone])

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
  // Marked feed is lazy: it has no bell badge, so it only fetches once the
  // viewer opens the Marked tab. `markedTabOpened` latches true on first open
  // (the query then lives normally under communityKeys.inboxMarked()).
  const [markedTabOpened, setMarkedTabOpened] = useState(false)
  const inboxMarked = useInboxMarked(markedTabOpened)
  const marked = inboxMarked.marked
  const { mutate: unmarkMessageMutate } = useUnmarkMessage()
  // Popover open-state + auto-collapse: the inbox closes itself once the row
  // the viewer clicked leaves the list. See use-inbox-auto-collapse.
  const inbox = useInboxAutoCollapse({ unreads: unreadFeed, unreadDms, mentions })
  const watchInboxItem = inbox.watchItem

  // Mutations wired through the shell.
  // Destructure the STABLE mutation methods, not the whole mutation object.
  // TanStack's `useMutation` returns a fresh wrapper object every render but
  // binds `.mutate`/`.mutateAsync` stably; depending on the wrapper made every
  // rail callback below rebuild each render, busting ServerRail's memo and
  // re-rendering the whole shell (children included) on any shell re-render.
  // Mirrors the message-side fix (see page.tsx messageActions deps note).
  const { mutateAsync: createServerAsync } = useCreateServer()
  const { mutate: leaveServerMutate } = useLeaveServer()
  const { mutate: uploadServerIconMutate } = useUploadServerIcon()
  const { mutate: deleteFolderMutate } = useDeleteServerFolder()
  const { mutate: reorderServersMutate } = useReorderServers()
  const { mutate: reorderFoldersMutate } = useReorderFolders()
  const { mutate: updateFolderItemsMutate } = useUpdateFolderItems()
  const { mutate: createFolderWithMutate } = useCreateServerFolderWith()
  const createOrGetDm = useCreateOrGetDm()
  const { accept: acceptDmMessage } = useDmMessageSender()
  const markAllInboxRead = useMarkAllInboxRead()
  const deleteMention = useDeleteMention()
  const { mutate: readForumThreadFromInbox } = useReadForumThreadFromInbox()
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
  const [preview, setPreview] = useState<ImagePreview | null>(null)
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
    (id: string) => { markSwitch("server", id); router.push(`/c/channels/${id}`) },
    [router],
  )
  const onRailCreateServer = useCallback(
    async (name: string, icon?: File) => {
      try {
        const data = await createServerAsync({ name })
        const newId = data.server.id
        toast(`Server "${name}" created`)
        if (icon) {
          uploadServerIconMutate(
            { serverId: newId, file: icon },
            { onError: (e) => toastApiError(e, "Server created, but the icon failed to upload") },
          )
        }
        router.push(`/c/channels/${newId}`)
      } catch (e) {
        toastApiError(e, "Failed to create server")
      }
    },
    [createServerAsync, uploadServerIconMutate, router],
  )
  const onRailLeaveServer = useCallback(
    (id: string) => {
      // Mark BEFORE mutate — the WS `member.leave` fanout / servers-list
      // refetch can race the mutation callback and reach the layout's
      // eject effect first. Marker present → layout stays silent and
      // this button owns the "Left server" toast.
      markVoluntaryLeave(id)
      leaveServerMutate(
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
    [leaveServerMutate, currentServerId, router, servers],
  )
  const onRailOpenSettings = useCallback(
    (id?: string) => {
      if (!id) return
      const action = resolveServerRailOverlayAction({
        targetServerId: id,
        activeServerId,
        overlay: "settings",
        hasActiveOpener: !!onOpenActiveServerSettings,
      })
      if (action.kind === "open-active") onOpenActiveServerSettings?.()
      else router.push(action.href)
    },
    [activeServerId, onOpenActiveServerSettings, router],
  )
  const onRailOpenInvitePopover = useCallback(
    (id?: string) => {
      if (!id) return
      const action = resolveServerRailOverlayAction({
        targetServerId: id,
        activeServerId,
        overlay: "invite",
        hasActiveOpener: !!onOpenActiveServerInvite,
      })
      if (action.kind === "open-active") onOpenActiveServerInvite?.()
      else router.push(action.href)
    },
    [activeServerId, onOpenActiveServerInvite, router],
  )
  const onRailUngroupFolder = useCallback(
    (fId: string) => {
      deleteFolderMutate(
        { folderId: fId },
        {
          onSuccess: () => toast("Group removed"),
          onError: (e) => toastApiError(e, "Failed to remove group"),
        },
      )
    },
    [deleteFolderMutate],
  )
  const onRailReorderRail = useCallback(
    (ids: string[]) => {
      reorderServersMutate(
        { serverIds: ids },
        { onError: (e) => toastApiError(e, "Failed to save server order") },
      )
    },
    [reorderServersMutate],
  )
  const onRailReorderFolders = useCallback(
    (ids: string[]) => {
      reorderFoldersMutate(
        { folderIds: ids },
        { onError: (e) => toastApiError(e, "Failed to reorder groups") },
      )
    },
    [reorderFoldersMutate],
  )
  const onRailFolderItemsChange = useCallback(
    (fId: string, ids: string[]) => {
      updateFolderItemsMutate(
        { folderId: fId, serverIds: ids },
        { onError: (e) => toastApiError(e, "Failed to update group") },
      )
    },
    [updateFolderItemsMutate],
  )
  const onRailDragCreateFolder = useCallback(
    (a: string, b: string) => {
      createFolderWithMutate(
        { serverIdA: a, serverIdB: b },
        { onError: (e) => toastApiError(e, "Failed to create group") },
      )
    },
    [createFolderWithMutate],
  )

  const railProps = {
    servers: railServers,
    folders,
    activeServerId,
    serversLoading: serversQuery.isLoading,
    setMobileZone,
    view,
    onHome: goHome,
    onServer: goServer,
    onServerNavigate: onRailServerNavigate,
    onCreateServer: onRailCreateServer,
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
        setProfile({
          data: buildSelfProfile(currentUser, onlineUserIds),
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

  const previewImage = useCallback((image: ImagePreview) => setPreview(image), [])
  const goBackMobile = useCallback(() => setMobileZone("nav"), [setMobileZone])
  // Navigate for channel/server-ref pills. They live deep in the memoized
  // Streamdown message tree where a subtree `useRouter().push` is a no-op; the
  // shell's router is the live one (rail clicks above navigate through it), so
  // the pills route through this bridge instead.
  const navigate = useCallback(
    (serverId: string, channelId?: string) => {
      markSwitch(channelId ? "channel" : "server", channelId ?? serverId)
      router.push(channelId ? `/c/channels/${serverId}/${channelId}` : `/c/channels/${serverId}`)
    },
    [router],
  )
  useEffect(() => {
    useCommunityStore.getState().registerUiHandlers({
      previewImage,
      openProfile,
      goBackMobile,
      navigate,
    })
  }, [previewImage, openProfile, goBackMobile, navigate])

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
    const trimmed = text.trim()
    if (trimmed) {
      const receipt = acceptDmMessage({
        dmId,
        content: trimmed,
        author: {
          id: currentUser.id,
          name: currentUser.name,
          avatar: currentUser.avatar,
        },
      })
      if (!receipt.accepted) {
        toast("Failed to send message")
        return
      }
      void receipt.committed
    }
    router.push(`/c/me/${dmId}`)
  }

  const openServerChannel = useCallback(
    (sid: string, cid: string, watchKey: string = `channel:${cid}`) => {
      // No PUT here — the channel/thread page's `useEagerChannelRead` fires the
      // mark-read on mount, AFTER its read-state snapshot latches, so the NEW
      // divider still anchors to the pre-open pointer. Navigating is enough.
      // `watchKey` lets the caller own what row the inbox watches for removal —
      // a mention click passes `mention:<id>` so the mention row (not the
      // channel, which may persist to host unread children) drives the collapse.
      watchInboxItem(watchKey)
      router.push(`/c/channels/${sid}/${cid}`)
    },
    [router, watchInboxItem],
  )

  const openForumThreadFromInbox = useCallback(
    (sid: string, parentChannelId: string, childChannelId: string, openerMessageId: string) => {
      // Start the parent progressive read first, but never gate opening the
      // child on network success. The mutation has no optimistic trim: success
      // refreshes Inbox/server aggregates, while failure toasts and leaves the
      // opener unread for a later retry.
      watchInboxItem(`channel:${childChannelId}`)
      readForumThreadFromInbox({ parentChannelId, openerMessageId })
      router.push(`/c/channels/${sid}/${childChannelId}`)
    },
    [readForumThreadFromInbox, router, watchInboxItem],
  )

  // A Marked row is cross-channel — clicking one navigates to the message's
  // channel AND opens the context sheet on it (Gus: always land on the channel
  // so you see WHERE the message lives, then the sheet shows it + its context;
  // same feel as a DM row). Both surfaces use the same `?seq=<n>` deep-link the
  // destination page reads to open its sheet — server rows go to
  // `/c/channels/<s>/<c>`, DM rows to `/c/me/<channelId>` (a DM channel's id IS
  // its `/c/me/<id>` route param). serverId (null ⇒ DM) picks the route only.
  // `watchInboxItem` collapses the popover once the destination opens.
  const openMarked = useCallback(
    (mk: Marked) => {
      watchInboxItem(`marked:${mk.id}`)
      const seqQuery = mk.m.seq != null ? `?seq=${mk.m.seq}` : ""
      if (mk.serverId) {
        router.push(`/c/channels/${mk.serverId}/${mk.channelId}${seqQuery}`)
      } else {
        router.push(`/c/me/${mk.channelId}${seqQuery}`)
      }
    },
    [router, watchInboxItem],
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
      watchInboxItem(`dm:${dmId}`)
      router.push(`/c/me/${dmId}`)
    },
    [router, queryClient, watchInboxItem],
  )

  const inboxElement = (
    <InboxPopover
      unreads={unreadFeed}
      unreadDms={unreadDms}
      mentions={mentions}
      marked={marked}
      markedLoading={inboxMarked.isLoading}
      loading={inboxLoading}
      onOpenChannel={openServerChannel}
      onOpenForumThread={openForumThreadFromInbox}
      onOpenDm={openInboxDm}
      onOpenMention={(mention) => {
        if (mention.serverId && mention.channelId) openServerChannel(mention.serverId, mention.channelId, `mention:${mention.id}`)
      }}
      onOpenMarked={openMarked}
      onMarkedTabSelected={() => setMarkedTabOpened(true)}
      onMarkAllRead={() => { markAllInboxRead.mutate() }}
      onDeleteMention={(id) => deleteMention.mutate({ mentionId: id })}
      onUnmark={(messageId) => unmarkMessageMutate({ messageId })}
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
            useMessageStreamStore.getState().resetAll()
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
          <div
            className="absolute bottom-0 left-0 z-10"
            style={{
              width: desktopUserBarOverlayWidth(sidebarW),
              marginLeft: -COMMUNITY_RAIL_WIDTH,
            }}
          >
            <UserBar user={{ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar }} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} inbox={inboxElement} hasUnread={inboxHasUnread} inboxOpen={inbox.open} onInboxOpenChange={inbox.onOpenChange} />
          </div>
        </div>
        {profile && <ProfileCard key={`${profile.data.userId ?? profile.data.name}:${profile.x}:${profile.y}`} data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={!!profile.data.userId && profile.data.userId === currentUser.id} onUpdateStatus={updateOwnStatus} initialStatusEmoji={profile.initialStatusEmoji} initialStatusText={profile.initialStatusText} />}
        {preview && <ImageLightbox image={preview} onClose={() => setPreview(null)} />}
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
            <UserBar user={{ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar }} onOpenProfile={openProfile} onEditProfile={() => setEditingProfile(true)} inbox={inboxElement} hasUnread={inboxHasUnread} inboxOpen={inbox.open} onInboxOpenChange={inbox.onOpenChange} />
          </div>
        </>
      )}
      {mobileZone === "messages" && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          {children}
        </div>
      )}
      {profile && <ProfileCard key={`${profile.data.userId ?? profile.data.name}:${profile.x}:${profile.y}`} data={profile.data} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} onMessage={profileMessage} isSelf={!!profile.data.userId && profile.data.userId === currentUser.id} onUpdateStatus={updateOwnStatus} />}
      {preview && <ImageLightbox image={preview} onClose={() => setPreview(null)} />}
      {userSettingsDialog}
      {avatarCropDialog}
      {extraDialogs}
    </Shell>
  )
}
