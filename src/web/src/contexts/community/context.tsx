"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { useCommunityWs } from "@/hooks/community/use-community-ws"
import type {
  Server,
  FolderServer,
  CommunityFolder,
  Category,
  Msg,
  Thread,
  ForumPost,
  Member,
  Friend,
  PendingRequest,
  BlockedUser,
  DM,
  InviteRow,
  AuditEntry,
  InboxRow,
  Mention,
  Role,
} from "@/components/community/_types"
import type {
  CommunityMessageCreate,
  CommunityReactionAdd,
  CommunityReactionRemove,
  CommunityTypingStart,
  CommunityPresenceUpdate,
  CommunityDmNewMessage,
  CommunityDmTyping,
  CommunityMemberJoin,
  CommunityMemberLeave,
  CommunityMemberUpdate,
  CommunityFriendRequest,
  CommunityFriendAccept,
  CommunityFriendReject,
  CommunityFriendRemove,
  CommunityFriendBlock,
  CommunityPinAdd,
  CommunityPinRemove,
  CommunityServerUpdate,
  CommunityServerDelete,
  CommunityChannelCreate,
  CommunityChannelUpdate,
  CommunityChannelDelete,
  CommunityChannelReorder,
  CommunityCategoryCreate,
  CommunityCategoryUpdate,
  CommunityCategoryDelete,
  CommunityCategoryReorder,
  CommunityChildChannelCreate,
  CommunityChildChannelUpdate,
  ChannelType,
  CommunityRole,
} from "@alook/shared"
import { isServerOwner, TYPING_INDICATOR_TIMEOUT_MS } from "@alook/shared"

// ── Types ─────────────────────────────────────────────────────────────────────

export type CurrentUser = {
  id: string
  name: string
  email: string
  avatar: string
  aboutMe?: string
}

export type ServerDetail = {
  id: string
  name: string
  description: string
  icon: string | null
  ownerId: string
  categories: Category[]
}

export type CommunityContextValue = {
  // Current user (from session)
  currentUser: CurrentUser
  setCurrentUser: (fn: (u: CurrentUser) => CurrentUser) => void

  // Servers
  servers: Server[]
  serversLoading: boolean
  currentServerId: string | null
  currentServer: ServerDetail | null
  currentServerLoading: boolean

  // Channels
  currentChannelId: string | null
  currentChannelMeta: { name: string; parentChannelId: string | null } | null
  setCurrentChannelId: (id: string | null) => void

  // Members
  members: Member[]
  membersLoading: boolean

  // Friends
  friends: Friend[]
  pending: PendingRequest[]
  blocked: BlockedUser[]
  friendsLoading: boolean

  // DMs
  dms: DM[]
  dmsLoading: boolean

  // Messages (for current channel/dm)
  messages: Msg[]
  messagesLoading: boolean
  hasMoreMessages: boolean
  loadMoreMessages: () => void

  // Threads
  threads: Thread[]
  threadsLoading: boolean

  // Forum posts
  forumPosts: ForumPost[]
  forumPostsLoading: boolean

  // Pinned
  pinned: Msg[]
  pinnedLoading: boolean

  // Invites
  invites: InviteRow[]

  // Audit log
  auditLog: AuditEntry[]

  // Inbox
  inboxFeed: InboxRow[]
  mentions: Mention[]

  // Presence
  onlineUserIds: Set<string>

  // Typing
  typingUsers: string[]

  // Folders
  folders: CommunityFolder[]

  // Notification level
  notifLevel: string
  channelNotif: Record<string, string>

  // Mutations
  sendMessage: (content: string, opts?: { replyToId?: string; attachments?: { url: string; filename: string; contentType: string; size: number }[] }) => Promise<string | null>
  sendDmMessage: (dmId: string, content: string, opts?: { attachments?: { url: string; filename: string; contentType: string; size: number }[] }) => Promise<void>
  sendThreadMessage: (threadId: string, content: string, opts?: { attachments?: { url: string; filename: string; contentType: string; size: number }[] }) => Promise<void>
  fetchThreadMessages: (threadId: string) => Promise<void>
  toggleReaction: (messageId: string, emoji: string) => void
  pinMessage: (messageId: string) => void
  unpinMessage: (messageId: string) => void
  createThread: (messageId: string, name: string) => Promise<string | null>
  sendFriendRequest: (username: string) => Promise<void>
  acceptFriendRequest: (id: string) => Promise<void>
  rejectFriendRequest: (id: string) => Promise<void>
  removeFriend: (id: string) => Promise<void>
  blockUser: (userId: string) => Promise<void>
  unblockUser: (userId: string) => Promise<void>
  createServer: (name: string) => Promise<string | null>
  joinServer: (inviteCode: string) => Promise<string | null>
  leaveServer: (serverId: string) => Promise<void>
  setMemberRole: (memberId: string, role: Role) => Promise<void>
  kickMember: (memberId: string) => Promise<void>
  createInvite: () => Promise<void>
  revokeInvite: (code: string) => Promise<void>
  updateServer: (name: string, description: string) => Promise<void>
  setNotifLevel: (level: string) => void
  setChannelNotif: (channelId: string, level: string) => void
  markChannelRead: (channelId: string) => void
  markDmRead: (dmId: string) => void
  markAllInboxRead: () => void
  openInboxItem: (id: string) => void
  dismissInboxItem: (id: string) => void
  deleteMention: (id: string) => void
  sendTyping: (target: { channelId?: string; dmConversationId?: string; threadId?: string }) => void
  createForumPost: (channelId: string, post: { name: string; content: string; tags: string[] }) => Promise<void>
  createChannel: (serverId: string, categoryId: string, name: string, type: ChannelType) => Promise<string | null>
  createCategory: (serverId: string, name: string, opts?: { private?: boolean }) => Promise<string | null>
  deleteChannel: (channelId: string) => Promise<void>
  deleteCategory: (serverId: string, categoryId: string) => Promise<void>
  updateCategory: (serverId: string, categoryId: string, opts: { name?: string; isPrivate?: boolean }) => Promise<void>
  reorderServers: (serverIds: string[]) => Promise<void>
  reorderCategories: (serverId: string, categoryIds: string[]) => Promise<void>
  reorderChannels: (serverId: string, channelIds: string[]) => Promise<void>
  deleteServer: (serverId: string) => Promise<void>
  uploadFile: (target: { channelId?: string; dmId?: string; threadId?: string }, file: File) => Promise<{ url: string; filename: string; contentType: string; size: number } | null>
  uploadServerIcon: (serverId: string, file: File) => Promise<string | null>
  setServerNotifLevel: (serverId: string, level: string) => Promise<void>
  createOrGetDm: (userId: string) => Promise<string | null>
  createServerFolderWith: (serverIdA: string, serverIdB: string) => Promise<void>
  updateFolderItems: (folderId: string, serverIds: string[]) => Promise<void>
  deleteServerFolder: (folderId: string) => Promise<void>
  reorderFolders: (folderIds: string[]) => Promise<void>

  // Navigation
  setCurrentServerId: (id: string | null) => void
  refreshServers: () => void
  refreshMembers: () => void
  refreshFriends: () => void
  refreshDms: () => void
  refreshMessages: () => void

  // UI actions (layout registers handlers, pages call them)
  previewImage: (url: string) => void
  openProfile: (name: string, e: React.MouseEvent) => void
  goBackMobile: () => void
  registerUiHandlers: (handlers: {
    previewImage: (url: string) => void
    openProfile: (name: string, e: React.MouseEvent) => void
    goBackMobile?: () => void
  }) => void
}

// ── Context ─────────────────────────────────────────────────────────────────────

const CommunityContext = createContext<CommunityContextValue | null>(null)

export function useCommunity() {
  const ctx = useContext(CommunityContext)
  if (!ctx) throw new Error("useCommunity must be used within CommunityProvider")
  return ctx
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function CommunityProvider({
  currentUser: initialUser,
  children,
}: {
  currentUser: CurrentUser
  children: ReactNode
}) {
  // ── Current user (with aboutMe from profile fetch) ──────────────────────
  const [currentUser, setCurrentUser] = useState<CurrentUser>(initialUser)

  // ── Server list ──────────────────────────────────────────────────────────
  const [servers, setServers] = useState<Server[]>([])
  const [serversLoading, setServersLoading] = useState(true)
  const [currentServerId, setCurrentServerId] = useState<string | null>(null)
  const [currentServer, setCurrentServer] = useState<ServerDetail | null>(null)
  const [currentServerLoading, setCurrentServerLoading] = useState(false)
  const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)
  const [currentChannelMeta, setCurrentChannelMeta] = useState<{ name: string; parentChannelId: string | null } | null>(null)

  // ── Members ──────────────────────────────────────────────────────────────
  const [members, setMembers] = useState<Member[]>([])
  const [membersLoading, setMembersLoading] = useState(false)

  // ── Friends ──────────────────────────────────────────────────────────────
  const [friends, setFriends] = useState<Friend[]>([])
  const [pending, setPending] = useState<PendingRequest[]>([])
  const [blocked, setBlocked] = useState<BlockedUser[]>([])
  const [friendsLoading, setFriendsLoading] = useState(true)

  // ── DMs ──────────────────────────────────────────────────────────────────
  const [dms, setDms] = useState<DM[]>([])
  const [dmsLoading, setDmsLoading] = useState(true)

  // ── Messages ─────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<Msg[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [messageCursor, setMessageCursor] = useState<string | null>(null)

  // ── Threads / forum ──────────────────────────────────────────────────────
  const [threads, setThreads] = useState<Thread[]>([])
  const [threadsLoading, setThreadsLoading] = useState(false)
  const [forumPosts, setForumPosts] = useState<ForumPost[]>([])
  const [forumPostsLoading, setForumPostsLoading] = useState(false)

  // ── Pinned ───────────────────────────────────────────────────────────────
  const [pinned, setPinned] = useState<Msg[]>([])
  const [pinnedLoading, setPinnedLoading] = useState(false)

  // ── Settings / invites / audit ───────────────────────────────────────────
  const [invites, setInvites] = useState<InviteRow[]>([])
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([])
  const [serverNotif, setServerNotif] = useState<Record<string, string>>({})
  const [channelNotif, setChannelNotifState] = useState<Record<string, string>>({})
  const notifLevel = serverNotif[currentServerId ?? ""] ?? "Only @mentions"
  const setNotifLevel = (level: string) => {
    if (currentServerId) setServerNotif((prev) => ({ ...prev, [currentServerId]: level }))
  }

  // ── Inbox ────────────────────────────────────────────────────────────────
  const [inboxFeed, setInboxFeed] = useState<InboxRow[]>([])
  const [mentions, setMentions] = useState<Mention[]>([])

  // ── Presence ─────────────────────────────────────────────────────────────
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set())

  // ── Typing ───────────────────────────────────────────────────────────────
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const typingTimers = useRef<Map<string, NodeJS.Timeout>>(new Map())
  useEffect(() => {
    return () => { typingTimers.current.forEach((t) => clearTimeout(t)) }
  }, [])

  // ── Folders ──────────────────────────────────────────────────────────────
  const [folders, setFolders] = useState<CommunityFolder[]>([])

  // Keep stable refs for WS callbacks
  const currentUserRef = useRef(currentUser)
  currentUserRef.current = currentUser
  const currentServerIdRef = useRef(currentServerId)
  currentServerIdRef.current = currentServerId
  const currentChannelIdRef = useRef(currentChannelId)
  currentChannelIdRef.current = currentChannelId
  const currentServerRef = useRef(currentServer)
  currentServerRef.current = currentServer

  // ── Fetch functions ──────────────────────────────────────────────────────

  const fetchServers = useCallback(async () => {
    setServersLoading(true)
    try {
      const data = await apiFetch<{ servers: Array<{ id: string; name: string; icon: string | null; role?: string; unread?: boolean; mentions?: number }> }>("/api/community/servers")
      const fresh = data.servers.map((s) => ({
        id: s.id,
        name: s.name,
        initial: s.name.charAt(0).toUpperCase(),
        active: false,
        unread: s.unread ?? false,
        mentions: s.mentions ?? 0,
        isOwner: isServerOwner(s.role),
        icon: s.icon ?? null,
      }))
      setServers((current) => {
        if (current.length === 0) return fresh
        // Preserve existing order, update fields, append new servers
        const freshMap = new Map(fresh.map((s) => [s.id, s]))
        const merged = current
          .filter((s) => freshMap.has(s.id))
          .map((s) => ({ ...s, ...freshMap.get(s.id)! }))
        const existingIds = new Set(current.map((s) => s.id))
        const added = fresh.filter((s) => !existingIds.has(s.id))
        return [...merged, ...added]
      })
    } catch {
      // Silently fail - servers list will be empty
    } finally {
      setServersLoading(false)
    }
  }, [])

  const fetchServerDetail = useCallback(async (serverId: string) => {
    if (serverId === "@me") return
    setCurrentServerLoading(true)
    try {
      const data = await apiFetch<ServerDetail>(`/api/community/servers/${serverId}`)
      setCurrentServer(data)
    } catch {
      setCurrentServer(null)
    } finally {
      setCurrentServerLoading(false)
    }
  }, [])

  const fetchMembers = useCallback(async () => {
    const sid = currentServerIdRef.current
    if (!sid || sid === "@me") return
    setMembersLoading(true)
    try {
      const data = await apiFetch<{ members: Member[] }>(`/api/community/servers/${sid}/members`)
      setMembers(data.members)
    } catch {
      setMembers([])
    } finally {
      setMembersLoading(false)
    }
  }, [])

  const fetchFriends = useCallback(async () => {
    setFriendsLoading(true)
    try {
      const [friendsData, pendingData] = await Promise.all([
        apiFetch<{ friends: Friend[]; blocked: BlockedUser[] }>("/api/community/friends"),
        apiFetch<{ pending: PendingRequest[] }>("/api/community/friends/pending"),
      ])
      setFriends(friendsData.friends)
      setBlocked(friendsData.blocked)
      setPending(pendingData.pending)
    } catch {
      // leave current state
    } finally {
      setFriendsLoading(false)
    }
  }, [])

  const fetchDms = useCallback(async () => {
    setDmsLoading(true)
    try {
      const data = await apiFetch<{ conversations: DM[] }>("/api/community/dm")
      setDms(data.conversations)
    } catch {
      // leave current state
    } finally {
      setDmsLoading(false)
    }
  }, [])

  const fetchFolders = useCallback(async () => {
    try {
      const data = await apiFetch<{ folders: Array<{ id: string; name: string; position: number; servers: Array<{ id: string; name: string; icon?: string | null }> }> }>("/api/community/server-folders")
      setFolders(data.folders.map((f) => ({
        id: f.id,
        name: f.name,
        position: f.position ?? 0,
        servers: f.servers.map((s) => ({ id: s.id, name: s.name, initial: s.name.charAt(0).toUpperCase(), icon: s.icon ?? null })),
      })))
    } catch {
      // leave current state
    }
  }, [])

  const fetchMessages = useCallback(async (channelId: string, cursor?: string) => {
    setMessagesLoading(true)
    try {
      const params = new URLSearchParams()
      if (cursor) params.set("cursor", cursor)
      const url = `/api/community/channels/${channelId}/messages${params.toString() ? `?${params}` : ""}`
      const data = await apiFetch<{ messages: Msg[]; hasMore: boolean; cursor?: string }>(url)
      if (cursor) {
        setMessages((prev) => [...data.messages, ...prev])
      } else {
        setMessages(data.messages)
      }
      setHasMoreMessages(data.hasMore)
      setMessageCursor(data.cursor ?? null)
    } catch {
      if (!cursor) setMessages([])
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  const fetchDmMessages = useCallback(async (dmId: string, cursor?: string) => {
    setMessagesLoading(true)
    try {
      const params = new URLSearchParams()
      if (cursor) params.set("cursor", cursor)
      const url = `/api/community/dm/${dmId}/messages${params.toString() ? `?${params}` : ""}`
      const data = await apiFetch<{ messages: Msg[]; hasMore: boolean; cursor?: string }>(url)
      if (cursor) {
        setMessages((prev) => [...data.messages, ...prev])
      } else {
        setMessages(data.messages)
      }
      setHasMoreMessages(data.hasMore)
      setMessageCursor(data.cursor ?? null)
    } catch {
      if (!cursor) setMessages([])
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  const fetchThreads = useCallback(async (channelId: string) => {
    setThreadsLoading(true)
    try {
      const data = await apiFetch<{ threads: Thread[] }>(`/api/community/channels/${channelId}/threads`)
      setThreads(data.threads)
    } catch {
      setThreads([])
    } finally {
      setThreadsLoading(false)
    }
  }, [])

  const fetchForumPosts = useCallback(async (channelId: string) => {
    setForumPostsLoading(true)
    try {
      const data = await apiFetch<{ posts: ForumPost[] }>(`/api/community/channels/${channelId}/posts`)
      setForumPosts(data.posts)
    } catch {
      setForumPosts([])
    } finally {
      setForumPostsLoading(false)
    }
  }, [])

  const fetchPinned = useCallback(async (channelId: string) => {
    setPinnedLoading(true)
    try {
      const data = await apiFetch<{ pins: Msg[] }>(`/api/community/channels/${channelId}/pins`)
      setPinned(data.pins)
    } catch {
      setPinned([])
    } finally {
      setPinnedLoading(false)
    }
  }, [])

  const fetchInbox = useCallback(async () => {
    try {
      const data = await apiFetch<InboxRow[] | { items: InboxRow[] }>("/api/community/inbox")
      setInboxFeed(Array.isArray(data) ? data : data.items ?? [])
    } catch {
      // silent
    }
  }, [])

  const fetchMentions = useCallback(async () => {
    try {
      const data = await apiFetch<Mention[] | { mentions: Mention[] }>("/api/community/mentions")
      setMentions(Array.isArray(data) ? data : data.mentions ?? [])
    } catch {
      // silent
    }
  }, [])

  // ── WebSocket ────────────────────────────────────────────────────────────
  const ws = useCommunityWs({
    onMessage: useCallback((event: CommunityMessageCreate) => {
      const msg = event.message
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev
        const attachments = msg.attachments?.map((a) => {
          const isImage = a.contentType?.startsWith("image/")
          return isImage
            ? { kind: "image" as const, name: a.filename, url: a.url }
            : { kind: "file" as const, name: a.filename, url: a.url, size: a.size ? `${Math.round(a.size / 1024)} KB` : "" }
        })
        return [
          ...prev,
          {
            id: msg.id,
            authorId: msg.authorId,
            authorName: msg.authorName,
            authorAvatar: msg.authorAvatar || (msg.authorName ?? "?").charAt(0).toUpperCase(),
            content: msg.content,
            createdAt: msg.createdAt,
            type: msg.type === "system" ? "system" : undefined,
            replyTo: msg.replyTo,
            ...(attachments?.length ? { attachments } : {}),
          },
        ]
      })
      // If this message is a reply to the current user, refresh mentions/inbox
      if (msg.replyTo && msg.authorId !== currentUserRef.current.id) {
        fetchMentions()
        fetchInbox()
      }
    }, [fetchMentions, fetchInbox]),
    onReaction: useCallback((event: CommunityReactionAdd | CommunityReactionRemove) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== event.messageId) return m
          const reactions = (m.reactions ?? []).map((r) => ({ ...r, userIds: [...(r.userIds ?? [])] }))
          if (event.type === "community:reaction.add") {
            const existing = reactions.find((r) => r.emoji === event.emoji)
            if (existing) {
              if (!existing.userIds.includes(event.userId)) {
                existing.userIds.push(event.userId)
                existing.count = existing.userIds.length
              }
              if (event.userId === currentUserRef.current.id) existing.me = true
            } else {
              reactions.push({ emoji: event.emoji, count: 1, me: event.userId === currentUserRef.current.id, userIds: [event.userId] })
            }
          } else {
            const idx = reactions.findIndex((r) => r.emoji === event.emoji)
            if (idx !== -1) {
              reactions[idx].userIds = reactions[idx].userIds.filter((id) => id !== event.userId)
              reactions[idx].count = reactions[idx].userIds.length
              if (event.userId === currentUserRef.current.id) reactions[idx].me = false
              if (reactions[idx].count <= 0) reactions.splice(idx, 1)
            }
          }
          return { ...m, reactions }
        })
      )
    }, []),
    onTyping: useCallback((event: CommunityTypingStart | CommunityDmTyping) => {
      const userId = event.userId
      if (userId === currentUserRef.current.id) return
      setTypingUsers((prev) => (prev.includes(userId) ? prev : [...prev, userId]))
      const existing = typingTimers.current.get(userId)
      if (existing) clearTimeout(existing)
      typingTimers.current.set(userId, setTimeout(() => {
        setTypingUsers((prev) => prev.filter((id) => id !== userId))
        typingTimers.current.delete(userId)
      }, TYPING_INDICATOR_TIMEOUT_MS))
    }, []),
    onPresence: useCallback((event: CommunityPresenceUpdate) => {
      setOnlineUserIds((prev) => {
        const next = new Set(prev)
        if (event.online) next.add(event.userId)
        else next.delete(event.userId)
        return next
      })
    }, []),
    onPin: useCallback((event: CommunityPinAdd | CommunityPinRemove) => {
      if (event.type === "community:pin.add") {
        const cid = currentChannelIdRef.current
        if (cid) fetchPinned(cid)
      } else {
        setPinned((prev) => prev.filter((p) => p.id !== event.messageId))
      }
    }, [fetchPinned]),
    onDm: useCallback((event: CommunityDmNewMessage | CommunityDmTyping) => {
      if (event.type === "community:dm.new_message") {
        const msg = event.message
        const attachments = msg.attachments?.map((a: { filename: string; url: string; contentType?: string; size?: number }) => {
          const isImage = a.contentType?.startsWith("image/")
          return isImage
            ? { kind: "image" as const, name: a.filename, url: a.url }
            : { kind: "file" as const, name: a.filename, url: a.url, size: a.size ? `${Math.round(a.size / 1024)} KB` : "" }
        })
        setDms((prev) =>
          prev.map((d) =>
            d.id !== event.dmConversationId
              ? d
              : {
                  ...d,
                  preview: msg.content.slice(0, 40),
                  unread: true,
                  messages: [
                    ...d.messages,
                    { id: msg.id, authorName: msg.authorName, authorAvatar: msg.authorAvatar, content: msg.content, createdAt: msg.createdAt, ...(attachments?.length ? { attachments } : {}) },
                  ],
                }
          )
        )
      }
    }, []),
    onFriend: useCallback((_event: CommunityFriendRequest | CommunityFriendAccept | CommunityFriendReject | CommunityFriendRemove | CommunityFriendBlock) => {
      fetchFriends()
    }, [fetchFriends]),
    onMember: useCallback((event: CommunityMemberJoin | CommunityMemberLeave | CommunityMemberUpdate) => {
      if (event.type === "community:member.join") {
        setMembers((prev) => [
          ...prev,
          { id: event.member.id, userId: event.member.userId, name: event.member.name, avatar: event.member.avatar ?? event.member.name.charAt(0).toUpperCase(), status: "online", sub: "", role: event.member.role as CommunityRole },
        ])
      } else if (event.type === "community:member.leave") {
        setMembers((prev) => prev.filter((m) => m.userId !== event.userId))
      } else if (event.type === "community:member.update") {
        setMembers((prev) => prev.map((m) => {
          if (m.id !== event.memberId) return m
          return {
            ...m,
            ...(event.changes.role ? { role: event.changes.role as CommunityRole } : {}),
            ...(event.changes.nickname !== undefined ? { name: event.changes.nickname ?? m.name } : {}),
          }
        }))
      }
    }, []),
    onServer: useCallback((event: CommunityServerUpdate | CommunityServerDelete) => {
      if (event.type === "community:server.update") {
        setServers((prev) => prev.map((s) => s.id !== event.serverId ? s : { ...s, name: event.changes.name ?? s.name }))
        if (currentServerRef.current && currentServerRef.current.id === event.serverId) {
          setCurrentServer((prev) => prev ? { ...prev, name: event.changes.name ?? prev.name, description: event.changes.description ?? prev.description } : prev)
        }
      } else {
        setServers((prev) => prev.filter((s) => s.id !== event.serverId))
        if (currentServerIdRef.current === event.serverId) {
          setCurrentServerId(null)
          setCurrentServer(null)
        }
      }
    }, []),
    onChannel: useCallback((_event: CommunityChannelCreate | CommunityChannelUpdate | CommunityChannelDelete | CommunityChannelReorder) => {
      const sid = currentServerIdRef.current
      if (sid && sid !== "@me") fetchServerDetail(sid)
    }, [fetchServerDetail]),
    onCategory: useCallback((_event: CommunityCategoryCreate | CommunityCategoryUpdate | CommunityCategoryDelete | CommunityCategoryReorder) => {
      const sid = currentServerIdRef.current
      if (sid && sid !== "@me") fetchServerDetail(sid)
    }, [fetchServerDetail]),
    onChildChannel: useCallback((event: CommunityChildChannelCreate | CommunityChildChannelUpdate) => {
      if (event.type === "community:channel.child_create") {
        const cid = currentChannelIdRef.current
        if (event.channel.type === "forum_post") {
          if (cid && event.parentChannelId === cid) fetchForumPosts(cid)
        } else {
          if (cid && event.parentChannelId === cid) fetchThreads(cid)
          if (event.parentMessageId) {
            setMessages((prev) => prev.map((m) =>
              m.id === event.parentMessageId
                ? { ...m, thread: { id: event.channel.id, name: event.channel.name, messageCount: 1 } }
                : m
            ))
          }
        }
      } else {
        // child_update — sync messageCount/name on the parent message's thread indicator
        const changes = event.changes
        if (changes.messageCount !== undefined || changes.name !== undefined) {
          setMessages((prev) => prev.map((m) =>
            m.thread?.id === event.channelId
              ? { ...m, thread: { ...m.thread, ...(changes.name !== undefined ? { name: changes.name } : {}), ...(changes.messageCount !== undefined ? { messageCount: changes.messageCount } : {}) } }
              : m
          ))
        }
      }
    }, [fetchForumPosts, fetchThreads]),
    onMention: useCallback(() => {
      fetchMentions()
      fetchInbox()
    }, [fetchMentions, fetchInbox]),
  })

  // ── UI dispatch (layout registers handlers, pages call these) ────────────
  const uiHandlersRef = useRef<{
    previewImage?: (url: string) => void
    openProfile?: (name: string, e: React.MouseEvent) => void
    goBackMobile?: () => void
  }>({})
  const registerUiHandlers = useCallback((handlers: { previewImage: (url: string) => void; openProfile: (name: string, e: React.MouseEvent) => void; goBackMobile?: () => void }) => {
    uiHandlersRef.current = handlers
  }, [])
  const previewImage = useCallback((url: string) => { uiHandlersRef.current.previewImage?.(url) }, [])
  const openProfileFn = useCallback((name: string, e: React.MouseEvent) => { uiHandlersRef.current.openProfile?.(name, e) }, [])
  const goBackMobile = useCallback(() => { uiHandlersRef.current.goBackMobile?.() }, [])

  // ── Effects: fetch on mount / server or channel change ───────────────────

  useEffect(() => {
    fetchServers()
    fetchFriends()
    fetchDms()
    fetchFolders()
    fetchInbox()
    fetchMentions()
    apiFetch<{ aboutMe: string }>("/api/community/users/me/profile")
      .then((data) => setCurrentUser((u) => ({ ...u, aboutMe: data.aboutMe })))
      .catch(() => {})
    apiFetch<Array<{ serverId?: string | null; channelId?: string | null; level: string }>>("/api/community/users/me/notifications")
      .then((settings) => {
        const channelSettings: Record<string, string> = {}
        const serverSettings: Record<string, string> = {}
        for (const s of settings) {
          if (s.channelId) {
            channelSettings[s.channelId] = s.level
          } else if (s.serverId) {
            serverSettings[s.serverId] = s.level
          }
        }
        if (Object.keys(channelSettings).length > 0) setChannelNotifState(channelSettings)
        if (Object.keys(serverSettings).length > 0) setServerNotif(serverSettings)
      })
      .catch(() => {})
  }, [fetchServers, fetchFriends, fetchDms, fetchFolders, fetchInbox, fetchMentions])

  useEffect(() => {
    if (!currentServerId || currentServerId === "@me") {
      setInvites([])
      setAuditLog([])
      return
    }
    fetchServerDetail(currentServerId)
    fetchMembers()
    apiFetch<{ online: string[] }>(`/api/community/servers/${currentServerId}/presence`)
      .then((data) => setOnlineUserIds(new Set(data.online)))
      .catch(() => {})
    // Fetch invites and audit log for settings
    apiFetch<{ invites: Array<{ id: string; token: string; maxUses: number | null; uses: number; expiresAt: string | null; createdAt: string; creatorName: string | null }> }>(`/api/community/servers/${currentServerId}/invites`)
      .then((data) => setInvites(data.invites.map((i) => ({ code: i.token, uses: i.uses, maxUses: i.maxUses, expiresAt: i.expiresAt, by: i.creatorName ?? "Unknown" }))))
      .catch(() => setInvites([]))
    apiFetch<{ entries: Array<{ log: { action: string; targetType: string; targetId: string; createdAt: string }; actor: { name: string | null } | null }> }>(`/api/community/servers/${currentServerId}/audit-log`)
      .then((data) => setAuditLog(data.entries.map((e) => ({ actor: e.actor?.name ?? "System", action: e.log.action.replace(/_/g, " "), target: e.log.targetType, createdAt: e.log.createdAt }))))
      .catch(() => setAuditLog([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentServerId])

  useEffect(() => {
    if (!currentChannelId) {
      setMessages((prev) => prev.length ? [] : prev)
      return
    }
    if (currentServerId === "@me") {
      ws.subscribe({ dmConversationId: currentChannelId })
      fetchDmMessages(currentChannelId)
    } else {
      // Wait for server detail to load before fetching — needed for forum detection
      if (!currentServer?.categories) return
      ws.subscribe({ channelId: currentChannelId })
      // Detect channel type from server categories
      const allChannels = currentServer.categories.flatMap((c) => c.channels)
      const channel = allChannels.find((ch) => ch.id === currentChannelId)
      if (channel?.type === "forum") {
        // Forum channel: show post listing
        setCurrentChannelMeta(null)
        fetchForumPosts(currentChannelId)
        fetchPinned(currentChannelId)
        fetchThreads(currentChannelId)
      } else if (channel) {
        // Top-level text channel
        setCurrentChannelMeta(null)
        fetchMessages(currentChannelId)
        fetchPinned(currentChannelId)
        fetchThreads(currentChannelId)
      } else {
        // Child channel (forum post / thread) — fetch its metadata + messages
        fetchMessages(currentChannelId)
        apiFetch<{ id: string; name: string; parentChannelId: string | null }>(`/api/community/threads/${currentChannelId}`)
          .then((data) => setCurrentChannelMeta({ name: data.name, parentChannelId: data.parentChannelId }))
          .catch(() => setCurrentChannelMeta(null))
      }
    }
    setTypingUsers([])
    typingTimers.current.forEach((t) => clearTimeout(t))
    typingTimers.current.clear()
    return () => { ws.unsubscribe() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChannelId, currentServerId, currentServer])

  // ── Mutation functions ───────────────────────────────────────────────────

  const sendMessage = useCallback(async (content: string, opts?: { replyToId?: string; attachments?: { url: string; filename: string; contentType: string; size: number }[] }): Promise<string | null> => {
    const cid = currentChannelIdRef.current
    const sid = currentServerIdRef.current
    if (!cid || sid === "@me") return null
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const optimisticAttachments = opts?.attachments?.map((a) => {
      const isImage = a.contentType.startsWith("image/")
      return isImage
        ? { kind: "image" as const, name: a.filename, url: a.url }
        : { kind: "file" as const, name: a.filename, url: a.url, size: `${Math.round(a.size / 1024)} KB` }
    })
    setMessages((prev) => {
      let replyTo: { id: string; authorName: string; text: string } | undefined
      if (opts?.replyToId) {
        const original = prev.find((m) => m.id === opts.replyToId)
        replyTo = { id: opts.replyToId, authorName: original?.authorName ?? "Unknown", text: (original?.content ?? "").slice(0, 100) }
      }
      return [
        ...prev,
        {
          id: tempId,
          authorName: currentUserRef.current.name,
          authorAvatar: currentUserRef.current.avatar,
          content,
          createdAt: new Date().toISOString(),
          ...(replyTo ? { replyTo } : {}),
          ...(optimisticAttachments?.length ? { attachments: optimisticAttachments } : {}),
        },
      ]
    })
    try {
      const result = await apiFetch<{ message: { id: string } }>(`/api/community/channels/${cid}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, replyToId: opts?.replyToId, attachments: opts?.attachments }),
      })
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, id: result.message.id } : m)))
      return result.message.id
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, failed: true } : m)))
      toast("Failed to send message")
      return null
    }
  }, [])

  const sendDmMessage = useCallback(async (dmId: string, content: string, opts?: { attachments?: { url: string; filename: string; contentType: string; size: number }[] }) => {
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const optimisticAttachments = opts?.attachments?.map((a) => {
      const isImage = a.contentType.startsWith("image/")
      return isImage
        ? { kind: "image" as const, name: a.filename, url: a.url }
        : { kind: "file" as const, name: a.filename, url: a.url, size: `${Math.round(a.size / 1024)} KB` }
    })
    setMessages((prev) => [
      ...prev,
      { id: tempId, authorName: currentUserRef.current.name, authorAvatar: currentUserRef.current.avatar, content, createdAt: new Date().toISOString(), ...(optimisticAttachments?.length ? { attachments: optimisticAttachments } : {}) },
    ])
    setDms((prev) => prev.map((d) => (d.id !== dmId ? d : { ...d, preview: content.slice(0, 40) })))
    try {
      const result = await apiFetch<{ message: { id: string } }>(`/api/community/dm/${dmId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, attachments: opts?.attachments }),
      })
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, id: result.message.id } : m)))
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, failed: true } : m)))
      toast("Failed to send message")
    }
  }, [])

  const sendThreadMessage = useCallback(async (threadId: string, content: string, opts?: { attachments?: { url: string; filename: string; contentType: string; size: number }[] }) => {
    // Optimistic update
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const optimisticAttachments = opts?.attachments?.map((a) => {
      const isImage = a.contentType.startsWith("image/")
      return isImage
        ? { kind: "image" as const, name: a.filename, url: a.url }
        : { kind: "file" as const, name: a.filename, url: a.url, size: `${Math.round(a.size / 1024)} KB` }
    })
    const optimisticMsg: Msg = {
      id: tempId,
      authorName: currentUserRef.current.name,
      authorAvatar: currentUserRef.current.avatar,
      content,
      createdAt: new Date().toISOString(),
      ...(optimisticAttachments?.length ? { attachments: optimisticAttachments } : {}),
    }
    const updateMessages = (setter: typeof setThreads | typeof setForumPosts) => {
      setter((prev: any[]) => prev.map((t: any) => t.id !== threadId ? t : { ...t, messages: [...t.messages, optimisticMsg] }))
    }
    updateMessages(setThreads)
    updateMessages(setForumPosts)
    try {
      const result = await apiFetch<{ id: string }>(`/api/community/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, attachments: opts?.attachments }),
      })
      // Replace temp id with real id
      const replaceId = (setter: typeof setThreads | typeof setForumPosts) => {
        setter((prev: any[]) => prev.map((t: any) => t.id !== threadId ? t : { ...t, messages: t.messages.map((m: any) => m.id === tempId ? { ...m, id: result.id ?? m.id } : m) }))
      }
      replaceId(setThreads)
      replaceId(setForumPosts)
    } catch {
      // Remove optimistic message on failure
      const removeTemp = (setter: typeof setThreads | typeof setForumPosts) => {
        setter((prev: any[]) => prev.map((t: any) => t.id !== threadId ? t : { ...t, messages: t.messages.filter((m: any) => m.id !== tempId) }))
      }
      removeTemp(setThreads)
      removeTemp(setForumPosts)
      toast("Failed to send message")
    }
  }, [])

  const fetchThreadMessages = useCallback(async (threadId: string) => {
    try {
      const data = await apiFetch<{ messages: Msg[] }>(`/api/community/threads/${threadId}/messages`)
      const msgs = data.messages
      // Update messages in both threads and forumPosts
      setThreads((prev) => prev.map((t) => t.id !== threadId ? t : { ...t, messages: msgs }))
      setForumPosts((prev) => prev.map((p) => p.id !== threadId ? p : { ...p, messages: msgs }))
    } catch {
      // silent
    }
  }, [])

  const reactionTimers = useRef<Map<string, { timer: NodeJS.Timeout; originalMe: boolean }>>(new Map())
  const toggleReaction = useCallback((messageId: string, emoji: string) => {
    const userId = currentUserRef.current.id
    const key = `${messageId}:${emoji}`

    let wasMe = false
    setMessages((prev) => {
      const msg = prev.find((m) => m.id === messageId)
      wasMe = msg?.reactions?.find((r) => r.emoji === emoji)?.me ?? false
      return prev.map((m) => {
        if (m.id !== messageId) return m
        const reactions = (m.reactions ?? []).map((r) => ({ ...r, userIds: [...(r.userIds ?? [])] }))
        const existing = reactions.find((r) => r.emoji === emoji)
        if (wasMe) {
          if (existing) {
            existing.userIds = existing.userIds.filter((id) => id !== userId)
            existing.count = existing.userIds.length
            existing.me = false
            if (existing.count <= 0) reactions.splice(reactions.indexOf(existing), 1)
          }
        } else if (existing) {
          existing.userIds.push(userId)
          existing.count = existing.userIds.length
          existing.me = true
        } else {
          reactions.push({ emoji, count: 1, me: true, userIds: [userId] })
        }
        return { ...m, reactions }
      })
    })

    const pending = reactionTimers.current.get(key)
    if (pending) {
      clearTimeout(pending.timer)
      if (pending.originalMe === !wasMe) {
        reactionTimers.current.delete(key)
        return
      }
    }

    const originalMe = pending?.originalMe ?? wasMe
    const timer = setTimeout(() => {
      reactionTimers.current.delete(key)
      const url = `/api/community/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`
      const method = originalMe ? "DELETE" : "PUT"
      apiFetch(url, { method }).catch(() => {
        setMessages((prev) => prev.map((m) => {
          if (m.id !== messageId) return m
          const reactions = (m.reactions ?? []).map((r) => ({ ...r, userIds: [...(r.userIds ?? [])] }))
          const existing = reactions.find((r) => r.emoji === emoji)
          if (originalMe) {
            if (existing) {
              existing.userIds.push(userId)
              existing.count = existing.userIds.length
              existing.me = true
            } else {
              reactions.push({ emoji, count: 1, me: true, userIds: [userId] })
            }
          } else if (existing) {
            existing.userIds = existing.userIds.filter((id) => id !== userId)
            existing.count = existing.userIds.length
            existing.me = false
            if (existing.count <= 0) reactions.splice(reactions.indexOf(existing), 1)
          }
          return { ...m, reactions }
        }))
      })
    }, 300)
    reactionTimers.current.set(key, { timer, originalMe })
  }, [])

  const pinMessage = useCallback((messageId: string) => {
    const cid = currentChannelIdRef.current
    if (!cid) return
    const msg = messages.find((m) => m.id === messageId)
    if (msg) setPinned((prev) => [msg, ...prev])
    apiFetch(`/api/community/channels/${cid}/pins`, {
      method: "POST",
      body: JSON.stringify({ messageId }),
    }).then(() => toast("Message pinned")).catch(() => {
      setPinned((prev) => prev.filter((p) => p.id !== messageId))
      toast("Failed to pin message")
    })
  }, [messages])

  const unpinMessage = useCallback((messageId: string) => {
    const cid = currentChannelIdRef.current
    if (!cid) return
    setPinned((prev) => prev.filter((p) => p.id !== messageId))
    apiFetch(`/api/community/channels/${cid}/pins/${messageId}`, { method: "DELETE" })
      .then(() => toast("Message unpinned"))
      .catch(() => toast("Failed to unpin message"))
  }, [])

  const createThread = useCallback(async (messageId: string, name: string): Promise<string | null> => {
    try {
      const data = await apiFetch<{ id: string }>(`/api/community/messages/${messageId}/threads`, {
        method: "POST",
        body: JSON.stringify({ name }),
      })
      const cid = currentChannelIdRef.current
      if (cid) fetchThreads(cid)
      // Mark the message as having a thread
      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, thread: { id: data.id, name, messageCount: 1 } } : m))
      return data.id
    } catch {
      toast("Failed to create thread")
      return null
    }
  }, [fetchThreads])

  const sendFriendRequest = useCallback(async (userId: string) => {
    try {
      await apiFetch("/api/community/friends/request", {
        method: "POST",
        body: JSON.stringify({ userId }),
      })
      toast("Friend request sent")
      fetchFriends()
    } catch {
      toast("Failed to send friend request")
    }
  }, [fetchFriends])

  const acceptFriendRequest = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/community/friends/${id}/accept`, { method: "POST" })
      toast("Friend request accepted")
      fetchFriends()
    } catch {
      toast("Failed to accept request")
    }
  }, [fetchFriends])

  const rejectFriendRequest = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/community/friends/${id}/reject`, { method: "POST" })
      fetchFriends()
    } catch {
      toast("Failed to reject request")
    }
  }, [fetchFriends])

  const removeFriend = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/community/friends/${id}`, { method: "DELETE" })
      toast("Friend removed")
      fetchFriends()
    } catch {
      toast("Failed to remove friend")
    }
  }, [fetchFriends])

  const blockUser = useCallback(async (userId: string) => {
    try {
      await apiFetch(`/api/community/users/${userId}/block`, { method: "POST" })
      toast("User blocked")
      fetchFriends()
    } catch {
      toast("Failed to block user")
    }
  }, [fetchFriends])

  const unblockUser = useCallback(async (userId: string) => {
    try {
      await apiFetch(`/api/community/users/${userId}/unblock`, { method: "POST" })
      toast("User unblocked")
      fetchFriends()
    } catch {
      toast("Failed to unblock user")
    }
  }, [fetchFriends])

  const createServer = useCallback(async (name: string): Promise<string | null> => {
    try {
      const data = await apiFetch<{ server: { id: string } }>("/api/community/servers", {
        method: "POST",
        body: JSON.stringify({ name }),
      })
      toast(`Server "${name}" created`)
      fetchServers()
      return data.server.id
    } catch {
      toast("Failed to create server")
      return null
    }
  }, [fetchServers])

  const joinServer = useCallback(async (inviteCode: string): Promise<string | null> => {
    // Extract token from full URL or raw token
    let token = inviteCode.trim()
    try {
      const url = new URL(token)
      const segments = url.pathname.split("/").filter(Boolean)
      const inviteIdx = segments.indexOf("invite")
      if (inviteIdx !== -1 && segments[inviteIdx + 1]) {
        token = segments[inviteIdx + 1]
      }
    } catch {
      // Not a URL — treat as raw token
    }
    try {
      const data = await apiFetch<{ serverId: string }>(`/api/community/invites/${token}/join`, { method: "POST" })
      toast("Joined server")
      await fetchServers()
      return data.serverId
    } catch {
      toast("Failed to join server")
      return null
    }
  }, [fetchServers])

  const leaveServer = useCallback(async (serverId: string) => {
    try {
      await apiFetch(`/api/community/servers/${serverId}/leave`, { method: "POST" })
      toast("Left server")
      setCurrentServerId(null)
      setCurrentServer(null)
      fetchServers()
    } catch {
      toast("Failed to leave server")
    }
  }, [fetchServers])

  const setMemberRole = useCallback(async (memberId: string, role: Role) => {
    const sid = currentServerIdRef.current
    if (!sid) return
    try {
      await apiFetch(`/api/community/servers/${sid}/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      })
      setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, role } : m)))
      toast(`Role updated`)
    } catch {
      toast("Failed to update role")
    }
  }, [])

  const kickMember = useCallback(async (memberId: string) => {
    const sid = currentServerIdRef.current
    if (!sid) return
    try {
      await apiFetch(`/api/community/servers/${sid}/members/${memberId}`, { method: "DELETE" })
      setMembers((prev) => prev.filter((m) => m.id !== memberId))
      toast("Member kicked")
    } catch {
      toast("Failed to kick member")
    }
  }, [])

  const createInvite = useCallback(async () => {
    const sid = currentServerIdRef.current
    if (!sid) return
    try {
      const data = await apiFetch<{ invite: { token: string; uses: number; maxUses: number | null; expiresAt: string | null } }>(`/api/community/servers/${sid}/invites`, { method: "POST" })
      setInvites((prev) => [{
        code: data.invite.token,
        uses: data.invite.uses,
        maxUses: data.invite.maxUses,
        expiresAt: data.invite.expiresAt,
        by: currentUser.name,
      }, ...prev])
      toast("Invite created")
    } catch {
      toast("Failed to create invite")
    }
  }, [currentUser.name])

  const revokeInvite = useCallback(async (code: string) => {
    try {
      await apiFetch(`/api/community/invites/${code}`, { method: "DELETE" })
      setInvites((prev) => prev.filter((i) => i.code !== code))
      toast("Invite revoked")
    } catch {
      toast("Failed to revoke invite")
    }
  }, [])

  const updateServer = useCallback(async (name: string, description: string) => {
    const sid = currentServerIdRef.current
    if (!sid) return
    try {
      await apiFetch(`/api/community/servers/${sid}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description }),
      })
      setCurrentServer((prev) => prev ? { ...prev, name, description } : prev)
      setServers((prev) => prev.map((s) => (s.id === sid ? { ...s, name, initial: name.charAt(0).toUpperCase() } : s)))
      toast("Server updated")
    } catch {
      toast("Failed to update server")
    }
  }, [])

  const setChannelNotif = useCallback((channelId: string, level: string) => {
    setChannelNotifState((prev) => ({ ...prev, [channelId]: level }))
    apiFetch(`/api/community/users/me/notifications/channel/${channelId}`, {
      method: "PUT",
      body: JSON.stringify({ level }),
    }).catch(() => {})
  }, [])

  const markChannelRead = useCallback((channelId: string) => {
    apiFetch(`/api/community/channels/${channelId}/read`, { method: "PUT" }).catch(() => {})
  }, [])

  const markDmRead = useCallback((dmId: string) => {
    apiFetch(`/api/community/dm/${dmId}/read`, { method: "PUT" }).catch(() => {})
    setDms((prev) => prev.map((d) => (d.id === dmId ? { ...d, unread: false } : d)))
  }, [])

  const markAllInboxRead = useCallback(() => {
    const messageIds = mentions.map((m) => m.m.id)
    setInboxFeed((prev) => prev.map((f) => ({ ...f, unread: false })))
    setMentions([])
    if (messageIds.length > 0) {
      apiFetch("/api/community/mentions/read", { method: "PUT", body: JSON.stringify({ messageIds }) }).catch(() => {})
    }
  }, [mentions])

  const openInboxItem = useCallback((id: string) => {
    setInboxFeed((prev) => prev.map((f) => (f.id === id ? { ...f, unread: false } : f)))
  }, [])

  const dismissInboxItem = useCallback((id: string) => {
    setInboxFeed((prev) => prev.filter((f) => f.id !== id))
  }, [])

  const deleteMention = useCallback((id: string) => {
    setMentions((prev) => prev.filter((m) => m.id !== id))
    apiFetch(`/api/community/mentions/${id}`, { method: "DELETE" }).catch(() => {})
  }, [])

  const loadMoreMessages = useCallback(() => {
    if (!messageCursor) return
    const cid = currentChannelIdRef.current
    const sid = currentServerIdRef.current
    if (!cid) return
    if (sid === "@me") {
      fetchDmMessages(cid, messageCursor)
    } else {
      fetchMessages(cid, messageCursor)
    }
  }, [messageCursor, fetchMessages, fetchDmMessages])

  const createForumPost = useCallback(async (channelId: string, post: { name: string; content: string; tags: string[] }) => {
    try {
      const data = await apiFetch<{ post: ForumPost }>(`/api/community/channels/${channelId}/posts`, {
        method: "POST",
        body: JSON.stringify(post),
      })
      setForumPosts((prev) => [data.post, ...prev])
    } catch {
      toast("Failed to create post")
    }
  }, [])

  const createChannel = useCallback(async (serverId: string, categoryId: string, name: string, type: ChannelType): Promise<string | null> => {
    try {
      const data = await apiFetch<{ channel: { id: string } }>(`/api/community/servers/${serverId}/channels`, {
        method: "POST",
        body: JSON.stringify({ categoryId, name, type }),
      })
      await fetchServerDetail(serverId)
      return data.channel.id
    } catch {
      toast("Failed to create channel")
      return null
    }
  }, [fetchServerDetail])

  const createCategory = useCallback(async (serverId: string, name: string, opts?: { private?: boolean }): Promise<string | null> => {
    try {
      const data = await apiFetch<{ category: { id: string } }>(`/api/community/servers/${serverId}/categories`, {
        method: "POST",
        body: JSON.stringify({ name, private: opts?.private }),
      })
      await fetchServerDetail(serverId)
      return data.category.id
    } catch {
      toast("Failed to create category")
      return null
    }
  }, [fetchServerDetail])

  const deleteChannel = useCallback(async (channelId: string) => {
    try {
      await apiFetch(`/api/community/channels/${channelId}`, { method: "DELETE" })
      const sid = currentServerIdRef.current
      if (sid && sid !== "@me") await fetchServerDetail(sid)
    } catch {
      toast("Failed to delete channel")
    }
  }, [fetchServerDetail])

  const deleteCategory = useCallback(async (serverId: string, categoryId: string) => {
    try {
      await apiFetch(`/api/community/servers/${serverId}/categories/${categoryId}`, { method: "DELETE" })
      await fetchServerDetail(serverId)
    } catch {
      toast("Failed to delete category")
    }
  }, [fetchServerDetail])

  const updateCategory = useCallback(async (serverId: string, categoryId: string, opts: { name?: string; isPrivate?: boolean }) => {
    try {
      await apiFetch(`/api/community/servers/${serverId}/categories/${categoryId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: opts.name, private: opts.isPrivate }),
      })
    } catch {
      toast("Failed to update category")
    }
  }, [])

  const serversRef = useRef(servers)
  serversRef.current = servers
  const foldersRef = useRef(folders)
  foldersRef.current = folders

  const reorderServers = useCallback(async (serverIds: string[]) => {
    const prev = [...serversRef.current]
    setServers((current) => {
      const map = new Map(current.map((s) => [s.id, s]))
      return serverIds.map((id) => map.get(id)).filter(Boolean) as Server[]
    })
    try {
      await apiFetch("/api/community/servers/reorder", {
        method: "PATCH",
        body: JSON.stringify({ serverIds }),
      })
    } catch {
      setServers(prev)
      toast("Failed to save server order")
    }
  }, [])

  const reorderCategories = useCallback(async (serverId: string, categoryIds: string[]) => {
    try {
      await apiFetch(`/api/community/servers/${serverId}/categories/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ categoryIds }),
      })
    } catch {
      toast("Failed to save category order")
    }
  }, [])

  const reorderChannels = useCallback(async (serverId: string, channelIds: string[]) => {
    try {
      await apiFetch(`/api/community/servers/${serverId}/channels/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ channelIds }),
      })
    } catch {
      toast("Failed to save channel order")
    }
  }, [])

  const deleteServer = useCallback(async (serverId: string) => {
    try {
      await apiFetch(`/api/community/servers/${serverId}`, { method: "DELETE" })
      toast("Server deleted")
      setCurrentServerId(null)
      setCurrentServer(null)
      fetchServers()
    } catch {
      toast("Failed to delete server")
    }
  }, [fetchServers])

  const uploadFile = useCallback(async (target: { channelId?: string; dmId?: string; threadId?: string }, file: File): Promise<{ url: string; filename: string; contentType: string; size: number } | null> => {
    const formData = new FormData()
    formData.append("file", file)
    let path: string
    if (target.threadId) {
      path = `/api/community/threads/${target.threadId}/upload`
    } else if (target.dmId) {
      path = `/api/community/dm/${target.dmId}/upload`
    } else if (target.channelId) {
      path = `/api/community/channels/${target.channelId}/upload`
    } else {
      return null
    }
    try {
      const res = await fetch(path, { method: "POST", body: formData, credentials: "include" })
      if (!res.ok) throw new Error("Upload failed")
      const data = await res.json() as { url: string; filename: string; contentType: string; size: number }
      return data
    } catch {
      toast("Failed to upload file")
      return null
    }
  }, [])

  const uploadServerIcon = useCallback(async (serverId: string, file: File): Promise<string | null> => {
    const formData = new FormData()
    formData.append("file", file)
    try {
      const res = await fetch(`/api/community/servers/${serverId}/icon`, { method: "POST", body: formData, credentials: "include" })
      if (!res.ok) throw new Error("Upload failed")
      const data = await res.json() as { url: string }
      const bustUrl = `${data.url}?t=${Date.now()}`
      setCurrentServer((prev) => prev ? { ...prev, icon: bustUrl } : prev)
      setServers((prev) => prev.map((s) => s.id === serverId ? { ...s, icon: bustUrl } : s))
      toast("Server icon updated")
      return bustUrl
    } catch {
      toast("Failed to upload icon")
      return null
    }
  }, [])

  const setServerNotifLevel = useCallback(async (serverId: string, level: string) => {
    setNotifLevel(level)
    try {
      await apiFetch(`/api/community/users/me/notifications/server/${serverId}`, {
        method: "PUT",
        body: JSON.stringify({ level }),
      })
    } catch {
      toast("Failed to update notification level")
    }
  }, [])

  const createOrGetDm = useCallback(async (userId: string): Promise<string | null> => {
    try {
      const data = await apiFetch<{ conversation: { id: string } }>("/api/community/dm", {
        method: "POST",
        body: JSON.stringify({ userId }),
      })
      await fetchDms()
      return data.conversation.id
    } catch {
      toast("Failed to open DM")
      return null
    }
  }, [fetchDms])

  const createServerFolderWith = useCallback(async (serverIdA: string, serverIdB: string) => {
    // Optimistic: create a temp folder
    const tempId = `temp_${Date.now()}`
    const sA = serversRef.current.find((s) => s.id === serverIdA)
    const sB = serversRef.current.find((s) => s.id === serverIdB)
    const tempFolder: CommunityFolder = {
      id: tempId,
      name: "Group",
      position: foldersRef.current.length,
      servers: [sA, sB].filter(Boolean).map((s) => ({ id: s!.id, name: s!.name, initial: s!.initial, icon: s!.icon ?? null })),
    }
    setFolders((cur) => [...cur, tempFolder])

    try {
      const data = await apiFetch<{ id: string }>("/api/community/server-folders", {
        method: "POST",
        body: JSON.stringify({ name: "Group", serverIds: [serverIdA, serverIdB] }),
      })
      // Replace temp folder with real id
      setFolders((cur) => cur.map((f) => f.id === tempId ? { ...f, id: data.id } : f))
    } catch {
      setFolders((cur) => cur.filter((f) => f.id !== tempId))
      toast("Failed to create group")
    }
  }, [])

  const updateFolderItems = useCallback(async (targetFolderId: string, serverIds: string[]) => {
    const prevFolder = foldersRef.current.find((f) => f.id === targetFolderId)

    // Optimistic: update folder's servers
    setFolders((cur) => {
      if (serverIds.length === 0) {
        // Empty folder → delete it
        return cur.filter((f) => f.id !== targetFolderId)
      }
      return cur.map((f) => {
        if (f.id !== targetFolderId) return f
        const newServers = serverIds.map((id) => {
          const existing = f.servers.find((s) => s.id === id)
          if (existing) return existing
          const fromRail = serversRef.current.find((s) => s.id === id)
          return fromRail ? { id: fromRail.id, name: fromRail.name, initial: fromRail.initial, icon: fromRail.icon ?? null } : { id, name: "", initial: "?", icon: null }
        })
        return { ...f, servers: newServers }
      })
    })

    try {
      if (serverIds.length === 0) {
        await apiFetch(`/api/community/server-folders/${targetFolderId}`, { method: "DELETE" })
      } else {
        await apiFetch(`/api/community/server-folders/${targetFolderId}`, {
          method: "PATCH",
          body: JSON.stringify({ serverIds }),
        })
      }
    } catch {
      if (prevFolder) {
        setFolders((cur) => {
          const exists = cur.some((f) => f.id === targetFolderId)
          if (exists) return cur.map((f) => f.id === targetFolderId ? prevFolder : f)
          return [...cur, prevFolder]
        })
      }
      toast("Failed to update group")
    }
  }, [])

  const deleteServerFolder = useCallback(async (targetFolderId: string) => {
    const prevFolders = [...foldersRef.current]
    setFolders((cur) => cur.filter((f) => f.id !== targetFolderId))

    try {
      await apiFetch(`/api/community/server-folders/${targetFolderId}`, { method: "DELETE" })
      toast("Group removed")
    } catch {
      setFolders(prevFolders)
      toast("Failed to remove group")
    }
  }, [])

  const reorderFoldersApi = useCallback(async (folderIds: string[]) => {
    const prevFolders = [...foldersRef.current]
    setFolders((cur) => {
      const map = new Map(cur.map((f) => [f.id, f]))
      return folderIds.map((id, i) => {
        const f = map.get(id)
        return f ? { ...f, position: i } : null
      }).filter(Boolean) as CommunityFolder[]
    })

    try {
      await apiFetch("/api/community/server-folders/reorder", {
        method: "PATCH",
        body: JSON.stringify({ folderIds }),
      })
    } catch {
      setFolders(prevFolders)
      toast("Failed to reorder groups")
    }
  }, [])

  // ── Context value ────────────────────────────────────────────────────────

  const value = useMemo<CommunityContextValue>(
    () => ({
      currentUser,
      setCurrentUser,
      servers,
      serversLoading,
      currentServerId,
      currentServer,
      currentServerLoading,
      currentChannelId,
      currentChannelMeta,
      setCurrentChannelId,
      members: members.map((m) => ({ ...m, status: m.userId === currentUser.id || onlineUserIds.has(m.userId) ? "online" as const : "offline" as const })),
      membersLoading,
      friends: friends.map((f) => ({ ...f, status: onlineUserIds.has(f.id) ? "online" as const : "offline" as const })),
      pending,
      blocked,
      friendsLoading,
      dms,
      dmsLoading,
      messages,
      messagesLoading,
      hasMoreMessages,
      loadMoreMessages,
      threads,
      threadsLoading,
      forumPosts,
      forumPostsLoading,
      pinned,
      pinnedLoading,
      invites,
      auditLog,
      inboxFeed,
      mentions,
      onlineUserIds,
      typingUsers,
      folders,
      notifLevel,
      channelNotif,
      sendMessage,
      sendDmMessage,
      sendThreadMessage,
      fetchThreadMessages,
      toggleReaction,
      pinMessage,
      unpinMessage,
      createThread,
      sendFriendRequest,
      acceptFriendRequest,
      rejectFriendRequest,
      removeFriend,
      blockUser,
      unblockUser,
      createServer,
      joinServer,
      leaveServer,
      setMemberRole,
      kickMember,
      createInvite,
      revokeInvite,
      updateServer,
      setNotifLevel,
      setChannelNotif,
      markChannelRead,
      markDmRead,
      markAllInboxRead,
      openInboxItem,
      dismissInboxItem,
      deleteMention,
      sendTyping: ws.sendTyping,
      createForumPost,
      createChannel,
      createCategory,
      deleteChannel,
      deleteCategory,
      updateCategory,
      reorderServers,
      reorderCategories,
      reorderChannels,
      deleteServer,
      uploadFile,
      uploadServerIcon,
      setServerNotifLevel,
      createOrGetDm,
      createServerFolderWith,
      updateFolderItems,
      deleteServerFolder,
      reorderFolders: reorderFoldersApi,
      setCurrentServerId,
      refreshServers: fetchServers,
      refreshMembers: fetchMembers,
      refreshFriends: fetchFriends,
      refreshDms: fetchDms,
      refreshMessages: () => {
        const cid = currentChannelIdRef.current
        const sid = currentServerIdRef.current
        if (!cid) return
        if (sid === "@me") fetchDmMessages(cid)
        else fetchMessages(cid)
      },
      previewImage,
      openProfile: openProfileFn,
      goBackMobile,
      registerUiHandlers,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      currentUser, servers, serversLoading, currentServerId, currentServer, currentServerLoading,
      currentChannelId, members, membersLoading, friends, pending, blocked, friendsLoading,
      dms, dmsLoading, messages, messagesLoading, hasMoreMessages, loadMoreMessages,
      threads, threadsLoading, forumPosts, forumPostsLoading, pinned, pinnedLoading,
      invites, auditLog, inboxFeed, mentions, onlineUserIds, typingUsers, folders,
      notifLevel, channelNotif, sendMessage, sendDmMessage, sendThreadMessage,
      toggleReaction, pinMessage, unpinMessage, createThread, sendFriendRequest,
      acceptFriendRequest, rejectFriendRequest, removeFriend, blockUser, unblockUser,
      createServer, joinServer, leaveServer, setMemberRole, kickMember,
      createInvite, revokeInvite, updateServer, setChannelNotif, markChannelRead,
      markDmRead, markAllInboxRead, openInboxItem, dismissInboxItem, deleteMention,
      ws.sendTyping, createForumPost,
      createChannel, createCategory, deleteChannel, deleteCategory, updateCategory,
      reorderServers, reorderCategories, reorderChannels, deleteServer,
      uploadFile, uploadServerIcon, setServerNotifLevel, createOrGetDm,
      createServerFolderWith, updateFolderItems, deleteServerFolder, reorderFoldersApi,
      fetchServers, fetchMembers, fetchFriends, fetchDms, fetchMessages, fetchDmMessages,
    ]
  )

  return <CommunityContext.Provider value={value}>{children}</CommunityContext.Provider>
}
