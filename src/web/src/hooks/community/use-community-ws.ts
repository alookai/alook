"use client"

import { useCallback, useEffect, useRef } from "react"
import { useQueryClient, type InfiniteData } from "@tanstack/react-query"
import { useUserWs } from "@/lib/use-user-ws"
import { useCommunityStore } from "@/stores/community"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"
import {
  patchCacheJoin,
  patchCacheLeave,
  patchCacheUpdate,
  type MembersEnvelope,
} from "@/hooks/community/use-server-members"
import type { MessagesPage } from "@/hooks/community/use-messages"
import type {
  CommunityWsEvent,
  CommunityMessageCreate,
  CommunityReactionAdd,
  CommunityReactionRemove,
  CommunityMachineSummary,
  CommunityTypingStart,
  CommunityPresenceUpdate,
  CommunityChildChannelCreate,
  CommunityChildChannelUpdate,
  CommunityMemberJoin,
  CommunityMemberLeave,
  CommunityMemberUpdate,
  CommunityChannelCreate,
  CommunityChannelUpdate,
  CommunityChannelDelete,
  CommunityChannelReorder,
  CommunityPinAdd,
  CommunityPinRemove,
  CommunityFriendRequest,
  CommunityFriendAccept,
  CommunityFriendReject,
  CommunityFriendRemove,
  CommunityFriendBlock,
  CommunityServerUpdate,
  CommunityServerDelete,
  CommunityCategoryCreate,
  CommunityCategoryUpdate,
  CommunityCategoryDelete,
  CommunityCategoryReorder,
  CommunityMentionCreate,
  CommunityMachineCreated,
  CommunityMachineStatus,
  CommunityMachineUpdated,
  CommunityMachineRemoved,
} from "@alook/shared"
import { isCommunityEvent, TYPING_INDICATOR_TIMEOUT_MS, TYPING_INDICATOR_THROTTLE_MS } from "@alook/shared"
import type { Msg } from "@/components/community/_types"
import { avatarInitial } from "@/lib/community/avatar"
import { projectCommunityMessageCreate } from "@/lib/community/message-wire"
import type { CanonicalMessage } from "@/lib/community/message-stream"
import type { MachinesResponse } from "@/hooks/community/use-machines"
import type { ServersResponse, ServerDetail } from "@/hooks/community/use-servers"
import { patchChannelUnread } from "@/hooks/community/server-detail-cache"

/**
 * Community WebSocket handler.
 *
 * Every event either patches the TanStack Query cache directly (fast — no
 * refetch) or invalidates a query key (slow — triggers refetch). The choice
 * is driven by the reconciliation table in `plans/21-community-tech-debt-pass-2.md`.
 *
 * State this hook owns *outside* the query cache:
 * - `useCommunityWsStore.onlineUserIds` — presence set, WS-only.
 * - `useCommunityWsStore.seenMessageIds` — dedup for `message.create`.
 * - `useCommunityStore.typingByScope` + `typingTimers` — typing indicator,
 *   keyed by conversation scope with per-(scope, user) auto-expire timers.
 * - `useCommunityStore.lastTypingSent` — outbound typing.start rate limit.
 *
 * The subscription (which channel/DM is focused) is read from
 * `useCommunityStore.subscription`, not from local component state — that
 * way any consumer can call `useCommunityStore.getState().subscribe(...)`
 * and the WS handler picks it up on the next event.
 */

// ── Constants ─────────────────────────────────────────────────────────────

// Debounce inbox invalidation so a busy channel doesn't fire one refetch per
// message. 500ms matches the mark-channel-read debounce so both fire once per
// message burst.
const INBOX_INVALIDATE_DEBOUNCE_MS = 500

// ── Types (kept for backwards compat with any lingering imports) ─────────

export type Subscription = {
  // The focused regular channel/thread.
  channelId?: string
  // The focused DM's channel id. A DM is a channel now; this slot keeps its
  // name only to mark "the focused channel is a DM" so the handler routes its
  // events into the `dmMessages` cache and the `dm:` typing scope.
  dmConversationId?: string
}

/**
 * DEPRECATED callback shape retained until the God-context (`contexts/
 * community/context.tsx`) is deleted in Step 4. The primary integration path
 * now writes state directly into the query cache and Zustand stores; callers
 * subscribe via `useQuery` and receive updates through those channels.
 *
 * Passing callbacks still fires them (in addition to the cache patches) so
 * legacy consumers don't observe silent regressions during the migration.
 */
export type CommunityWsCallbacks = {
  onMessage?: (event: CommunityMessageCreate) => void
  onAnyMessage?: (event: CommunityMessageCreate) => void
  onReaction?: (event: CommunityReactionAdd | CommunityReactionRemove) => void
  onTyping?: (event: CommunityTypingStart) => void
  onPresence?: (event: CommunityPresenceUpdate) => void
  onChildChannel?: (event: CommunityChildChannelCreate | CommunityChildChannelUpdate) => void
  onMember?: (event: CommunityMemberJoin | CommunityMemberLeave | CommunityMemberUpdate) => void
  onChannel?: (event: CommunityChannelCreate | CommunityChannelUpdate | CommunityChannelDelete | CommunityChannelReorder) => void
  onPin?: (event: CommunityPinAdd | CommunityPinRemove) => void
  onFriend?: (event: CommunityFriendRequest | CommunityFriendAccept | CommunityFriendReject | CommunityFriendRemove | CommunityFriendBlock) => void
  onServer?: (event: CommunityServerUpdate | CommunityServerDelete) => void
  onCategory?: (event: CommunityCategoryCreate | CommunityCategoryUpdate | CommunityCategoryDelete | CommunityCategoryReorder) => void
  onMention?: (event: CommunityMentionCreate) => void
  onMachine?: (event: CommunityMachineCreated | CommunityMachineStatus | CommunityMachineUpdated | CommunityMachineRemoved) => void
}

// ── Cache patch helpers ───────────────────────────────────────────────────

type PageCache = InfiniteData<MessagesPage>

/**
 * Patch every cached message authored by `userId` to the renamed
 * `authorName` — `authorName` is a snapshot field written at send time
 * (`communityMessage` doesn't store it; the live JOIN is `message.ts`'s
 * `authorName: user.name`), so nothing else updates already-loaded message
 * rows after a self-rename. Only touches rows that are actually cached in
 * this client (open/previously-open channels & DMs) — a channel never
 * loaded this session picks up the new name for free on its first real
 * fetch, since that IS the live JOIN.
 */
function patchAuthorNameInCache(cache: PageCache | undefined, userId: string, newName: string): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    if (!p.messages.some((m) => m.authorId === userId)) return p
    touched = true
    return {
      ...p,
      messages: p.messages.map((m) => (m.authorId === userId ? { ...m, authorName: newName } : m)),
    }
  })
  if (!touched) return cache
  return { ...cache, pages }
}

/**
 * Patch the `approval` payload of a single cached message — the client-side
 * effect of a `MESSAGE_UPDATED` event. The card re-renders in its new
 * state (approved/denied/superseded/waiting) without a refetch.
 */
function patchApprovalInCache(
  cache: PageCache | undefined,
  messageId: string,
  approval: Msg["approval"],
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    if (!p.messages.some((m) => m.id === messageId)) return p
    touched = true
    return {
      ...p,
      messages: p.messages.map((m) => (m.id === messageId ? { ...m, approval } : m)),
    }
  })
  if (!touched) return cache
  return { ...cache, pages }
}

function applyReactionToCache(
  cache: PageCache | undefined,
  event: CommunityReactionAdd | CommunityReactionRemove,
  viewerUserId: string | null,
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    if (!p.messages.some((m) => m.id === event.messageId)) return p
    touched = true
    return {
      ...p,
      messages: p.messages.map((message) =>
        message.id === event.messageId
          ? applyReactionToMessage(message, event, viewerUserId)
          : message),
    }
  })
  if (!touched) return cache
  return { ...cache, pages }
}

function applyReactionToMessage(
  message: Msg,
  event: CommunityReactionAdd | CommunityReactionRemove,
  viewerUserId: string | null,
): Msg {
  const reactions = (message.reactions ?? []).map((reaction) => ({
    ...reaction,
    userIds: [...(reaction.userIds ?? [])],
  }))
  if (event.type === "community:reaction.add") {
    const existing = reactions.find((reaction) => reaction.emoji === event.emoji)
    if (existing) {
      if (!existing.userIds.includes(event.userId)) existing.userIds.push(event.userId)
      existing.count = existing.userIds.length
      if (viewerUserId && event.userId === viewerUserId) existing.me = true
    } else {
      reactions.push({
        emoji: event.emoji,
        count: 1,
        me: !!viewerUserId && event.userId === viewerUserId,
        userIds: [event.userId],
      })
    }
  } else {
    const index = reactions.findIndex((reaction) => reaction.emoji === event.emoji)
    if (index !== -1) {
      reactions[index].userIds = reactions[index].userIds.filter((id) => id !== event.userId)
      reactions[index].count = reactions[index].userIds.length
      if (viewerUserId && event.userId === viewerUserId) reactions[index].me = false
      if (reactions[index].count <= 0) reactions.splice(index, 1)
    }
  }
  return { ...message, reactions }
}

function findCachedMessage(cache: PageCache | undefined, messageId: string): Msg | undefined {
  for (const page of cache?.pages ?? []) {
    const message = page.messages.find((row) => row.id === messageId)
    if (message) return message
  }
  return undefined
}

// ── Public hook ────────────────────────────────────────────────────────────

/**
 * Optional args — the community feature needs to know the viewer's userId so
 * reactions from that user light up the "me" flag. Passing null keeps the
 * hook usable in places where the viewer identity isn't yet loaded.
 */
export type UseCommunityWsOptions = CommunityWsCallbacks & {
  viewerUserId?: string | null
}

// Overload for the new call-site: `useCommunityWs()` with no args — the hook
// runs cache reconciliation and returns `{ subscribe, unsubscribe, sendTyping }`.
// The legacy signature `useCommunityWs({ onMessage, ... })` still works during
// the God-context migration; callbacks fire in addition to cache patches.
// Module-level slot for the currently-active WS `send`. The root-mounted
// `useCommunityWs` writes into this on connect so free helpers below can
// dispatch typing events without needing to re-mount the hook (which would
// open a second WebSocket per consumer). Cleared on unmount.
let activeSend: ((msg: object) => void) | null = null

/** Testing hook — clears the module-scoped `activeSend` binding. */
export function _resetActiveSend_forTesting() {
  activeSend = null
}

/**
 * Subscribe to a channel/thread/DM. Free helper so any component can update
 * the focused subscription without holding a reference to `useCommunityWs`.
 */
export function communityWsSubscribe(target: Subscription) {
  useCommunityStore.getState().subscribe(target)
}

export function communityWsUnsubscribe() {
  useCommunityStore.getState().unsubscribe()
}

/**
 * Send a typing indicator. Client-side debounced at 8s per channelId (a DM is
 * a channel now, so its id is a channelId too). If no WS is connected, the
 * call is a no-op — subsequent connections don't retroactively fire missed
 * typings.
 */
export function communityWsSendTyping(target: { channelId: string }) {
  const key = target.channelId
  if (!key) return
  const send = activeSend
  if (!send) return

  const now = Date.now()
  const map = useCommunityStore.getState().lastTypingSent
  const lastSent = map.get(key) || 0
  if (now - lastSent < TYPING_INDICATOR_THROTTLE_MS) return

  map.set(key, now)
  send({ type: "community:typing.start", channelId: key })
}

/**
 * Reset the outbound typing.start throttle for a channel. Sending a message
 * ends the current typing burst; the very next keystroke should re-emit
 * typing.start immediately, not wait out the 8s dedup window.
 */
export function communityWsResetTypingThrottle(target: { channelId: string }) {
  const key = target.channelId
  if (!key) return
  useCommunityStore.getState().lastTypingSent.delete(key)
}

export function useCommunityWs(options?: UseCommunityWsOptions) {
  const queryClient = useQueryClient()
  const viewerUserIdRef = useRef<string | null>(options?.viewerUserId ?? null)
  const callbacksRef = useRef<CommunityWsCallbacks>(options ?? {})
  useEffect(() => {
    viewerUserIdRef.current = options?.viewerUserId ?? null
    callbacksRef.current = options ?? {}
  })

  // #3: the previous WS-driven auto-mark-read (a `useMarkChannelRead()` call
  // fired on every foreign-authored message in the focused channel) has
  // been removed. The IntersectionObserver in `useChannelWatermark` is now
  // authoritative — if a WS-delivered message actually becomes visible in
  // the viewport, IO advances the read pointer; if the user is scrolled up
  // reading history, the pointer stays put (which is the correct behavior).

  // Debounced inbox invalidation. Grouping repeated invalidations into one
  // refetch cycle keeps the popover from re-rendering on every message tick.
  const inboxDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleInboxInvalidate = useCallback(() => {
    if (inboxDebounce.current) return
    inboxDebounce.current = setTimeout(() => {
      inboxDebounce.current = null
      void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
      // A DM is a channel now, so a DM message arrives as `message.create`
      // with no discriminator distinguishing it from a channel message. Fold
      // the old `dm.new_message` DM-sidebar refresh in here: invalidate the
      // DM list too so an unread DM's preview/unread flag updates live. Cheap
      // — `communityKeys.dms()` is only observed under the `/c/me` layout, so
      // this is a no-op (marks stale, no refetch) while viewing a server
      // channel where the DM sidebar isn't mounted.
      void queryClient.invalidateQueries({ queryKey: communityKeys.dms() })
    }, INBOX_INVALIDATE_DEBOUNCE_MS)
  }, [queryClient])

  const handleMessage = useCallback(
    (msg: { type: string;[key: string]: unknown }) => {
      if (!isCommunityEvent(msg)) return
      const event = msg as CommunityWsEvent
      const sub = useCommunityStore.getState().subscription
      const wsStore = useCommunityWsStore.getState()
      const cbs = callbacksRef.current
      // A DM is a channel now — every message/typing/reaction event carries a
      // single `channelId`. The subscription still tracks two slots so the
      // handler can route a DM channel's events into the `dmMessages` cache vs
      // a regular channel's into `channelMessages` (`sub.dmConversationId`
      // holds the focused DM's channel id). An event is "focused" if its
      // channelId matches either slot.
      const matchesFocus = (e: { channelId?: string }): boolean => {
        if (!e.channelId) return false
        return e.channelId === sub.channelId || e.channelId === sub.dmConversationId
      }

      switch (event.type) {
        // ── Message create ──────────────────────────────────────────────
        case "community:message.create": {
          const projected = projectCommunityMessageCreate(event.message)
          if (event.channelId === sub.channelId) {
            const serverId = useCommunityStore.getState().currentServerId
            if (serverId) {
              useMessageStreamStore.getState().dispatch(
                { kind: "channel", id: event.channelId, serverId },
                { type: "wsMessage", message: projected },
              )
            }
          }
          if (event.channelId === sub.dmConversationId) {
            useMessageStreamStore.getState().dispatch(
              { kind: "dm", id: event.channelId },
              { type: "wsMessage", message: projected },
            )
          }
          if (wsStore.hasSeenMessage(event.message.id)) return
          wsStore.markSeenMessage(event.message.id)
          // Sending a message is an implicit typing.stop for its author —
          // clear once we know this is a fresh message. Clearing before dedup
          // would also clear on WS-reconnect replays of stale messages,
          // briefly wiping a still-active heartbeat pill. Derive the scope
          // from whether this channelId is the focused DM channel (`dm:`) or a
          // regular channel (`ch:`) so the pill clears in the right bucket.
          clearTypingIndicator(typingScopeKey(event, sub), event.message.authorId)

          // 1) Patch the focused channel/dm page cache if the event matches.
          //    A DM is a channel, distinguished only by which subscription slot
          //    its channelId lands in.
          if (event.channelId === sub.channelId) {
            // A thread/forum_post enrolls its sender + mentioned users as
            // participants server-side on send. That set IS its Members panel,
            // so refetch it live — otherwise a new speaker/mention only appears
            // after a manual refresh. No-op for a plain channel (whose panel is
            // the access roster, not participants); the query is disabled there.
            void queryClient.invalidateQueries({
              queryKey: communityKeys.threadParticipants(event.channelId),
            })
          }

          // 2) Every message.create — regardless of focus — schedules a
          //    debounced inbox invalidation. Skip messages authored by the
          //    viewer since they never affect their own unreads.
          const viewerId = viewerUserIdRef.current
          if (event.message.authorId !== viewerId) {
            scheduleInboxInvalidate()
          }

          // 3) Live channel-sidebar unread dot is NO LONGER flipped here.
          //    Unread is per-recipient and mute-gated on the server now, so it
          //    rides the dedicated `community:unread.bump` event (below) — a
          //    muted (`nothing`/unmentioned-`mentions`) channel must NOT light
          //    an unread dot even though its `message.create` still arrives
          //    (mute ≠ blindness: content syncs, the badge does not).

          // Note: no auto-mark-read here. See #3 — the
          // IntersectionObserver in `useChannelWatermark` advances the
          // read pointer when a message actually becomes visible in the
          // viewport. If the user is scrolled up reading history, their
          // pointer must stay put; the WS handler cannot know whether the
          // incoming message is on screen.

          // Legacy callback fanout — cache patches above are authoritative.
          cbs.onAnyMessage?.(event)
          if (matchesFocus(event)) cbs.onMessage?.(event)
          return
        }

        // ── Per-user unread/badge signal ─────────────────────────────────
        // Mute-gated on the server (only recipients whose effective level
        // delivers get this), so the sidebar unread dot flips ONLY here — a
        // muted channel's `message.create` no longer lights it. Skip the
        // currently-subscribed channel (dot suppressed there anyway) and never
        // for the viewer's own sends (the server excludes the author, but guard
        // defensively).
        case "community:unread.bump": {
          const viewerId = viewerUserIdRef.current
          // The sidebar row to light: a thread/forum-post message has no
          // independent tree row, so its dot lights the PARENT channel
          // (`railChannelId`); a plain channel is its own row. Fall back to
          // `channelId` for older frames that predate `railChannelId`.
          const railChannelId = event.railChannelId ?? event.channelId
          // Suppress the dot for the channel the viewer is actually looking at
          // (its unread clears on read anyway) — compare against the ROW being
          // lit, so a thread bump whose parent is open still suppresses.
          if (event.userId === viewerId && railChannelId !== sub.channelId) {
            // Channel-tree dot: patch the RIGHT server's detail. `serverId`
            // (inbox-dot-ws-driven) lets an other-server message light its dot
            // — previously only the open server was patched, so cross-server
            // bumps never lit. Absent serverId (DM bump / older frame) → fall
            // back to the currently-open server (backward-compatible).
            const targetServerId =
              event.serverId ?? useCommunityStore.getState().currentServerId
            if (targetServerId) {
              queryClient.setQueryData<ServerDetail | undefined>(
                communityKeys.server(targetServerId),
                (cache) => patchChannelUnread(cache, railChannelId, true),
              )
            }
            // Rail mention badge: the rail row carries only a `mentions` count
            // (no separate unread dot — plain unread lives on the tree dot
            // above). So bump the rail badge ONLY for a mention, on the right
            // server row. Needs `serverId`; a DM/older frame without it can't
            // locate a rail row, so skip (the tree dot / inbox still reflect it).
            if (event.isMention && event.serverId) {
              const bumpServerId = event.serverId
              queryClient.setQueryData<ServersResponse | undefined>(
                communityKeys.servers(),
                (prev) =>
                  prev
                    ? {
                      ...prev,
                      servers: prev.servers.map((s) =>
                        s.id === bumpServerId
                          ? { ...s, mentions: s.mentions + 1 }
                          : s,
                      ),
                    }
                    : prev,
              )
            }
          }
          return
        }

        // ── Reactions ───────────────────────────────────────────────────
        case "community:reaction.add":
        case "community:reaction.remove": {
          const viewerId = viewerUserIdRef.current
          // A reaction event carries only `channelId` with no channel-vs-DM
          // discriminator. A regular channel's cache lives under
          // `channelMessages(id)`, a DM channel's under `dmMessages(id)` — patch
          // both keys; the one that doesn't exist receives `undefined` and the
          // updater returns it, a harmless no-op.
          queryClient.setQueryData<PageCache>(
            communityKeys.channelMessages(event.channelId),
            (c) => applyReactionToCache(c, event, viewerId),
          )
          queryClient.setQueryData<PageCache>(
            communityKeys.dmMessages(event.channelId),
            (c) => applyReactionToCache(c, event, viewerId),
          )
          if (event.channelId === sub.channelId) {
            const serverId = useCommunityStore.getState().currentServerId
            if (serverId) {
              const scope = { kind: "channel" as const, id: event.channelId, serverId }
              const fallback = [...getMessageOverlay(scope).liveById.values()]
                .find((message) => message.id === event.messageId)
              if (fallback) {
                const cached = findCachedMessage(
                  queryClient.getQueryData<PageCache>(communityKeys.channelMessages(event.channelId)),
                  event.messageId,
                )
                const source = cached?.seq !== undefined ? cached as CanonicalMessage : fallback
                useMessageStreamStore.getState().dispatch(scope, {
                  type: "liveRefreshed",
                  message: applyReactionToMessage(source, event, viewerId) as CanonicalMessage,
                })
              }
            }
          }
          if (event.channelId === sub.dmConversationId) {
            const scope = { kind: "dm" as const, id: event.channelId }
            const fallback = [...getMessageOverlay(scope).liveById.values()]
              .find((message) => message.id === event.messageId)
            if (fallback) {
              const cached = findCachedMessage(
                queryClient.getQueryData<PageCache>(communityKeys.dmMessages(event.channelId)),
                event.messageId,
              )
              const source = cached?.seq !== undefined ? cached as CanonicalMessage : fallback
              useMessageStreamStore.getState().dispatch(scope, {
                type: "liveRefreshed",
                message: applyReactionToMessage(source, event, viewerId) as CanonicalMessage,
              })
            }
          }
          if (matchesFocus(event)) cbs.onReaction?.(event)
          return
        }

        // ── Pins ────────────────────────────────────────────────────────
        case "community:pin.add":
        case "community:pin.remove": {
          void queryClient.invalidateQueries({ queryKey: communityKeys.pins(event.channelId) })
          if (matchesFocus(event)) cbs.onPin?.(event)
          return
        }

        // ── Typing (channel / thread / DM — all keyed by channelId) ──────
        case "community:typing.start": {
          const userId = event.userId
          const viewerId = viewerUserIdRef.current
          if (viewerId && userId === viewerId) return
          // Focus check: only surface typing for the currently-viewed target.
          if (!matchesFocus(event)) return
          applyTypingIndicator(typingScopeKey(event, sub), userId, event.name ?? null)
          cbs.onTyping?.(event)
          return
        }

        // ── Typing stop — explicit clear (bot turn-end path) ────────────
        // Symmetric with typing.start: only clear when focused on the same
        // target so a stop for a different DM doesn't wipe the local pill.
        case "community:typing.stop": {
          const userId = event.userId
          const viewerId = viewerUserIdRef.current
          if (viewerId && userId === viewerId) return
          if (!matchesFocus(event)) return
          clearTypingIndicator(typingScopeKey(event, sub), userId)
          return
        }

        // ── Child channels (threads + forum posts) ──────────────────────
        case "community:channel.child_create":
        case "community:channel.child_update": {
          // Cheap invalidate for the thread + forum-post lists. The parent
          // messages list also needs an update because the parent message's
          // thread indicator (`msg.thread`) changes — do a targeted
          // setQueryData patch when we know parentMessageId.
          void queryClient.invalidateQueries({
            queryKey: communityKeys.threads(event.parentChannelId),
          })
          void queryClient.invalidateQueries({
            queryKey: communityKeys.forumPosts(event.parentChannelId),
          })
          if (event.type === "community:channel.child_create") {
            if (event.parentMessageId) {
              queryClient.setQueryData<PageCache>(
                communityKeys.channelMessages(event.parentChannelId),
                (cache) => {
                  if (!cache) return cache
                  let touched = false
                  const pages = cache.pages.map((p) => {
                    if (!p.messages.some((m) => m.id === event.parentMessageId)) return p
                    touched = true
                    return {
                      ...p,
                      messages: p.messages.map((m) =>
                        m.id === event.parentMessageId
                          ? {
                            ...m,
                            thread: {
                              id: event.channel.id,
                              name: event.channel.name,
                              // #4: a freshly-created child channel has no
                              // messages yet — `1` was a false claim that
                              // the create event carried the first message
                              // (it doesn't; the message arrives separately).
                              messageCount: 0,
                            },
                          }
                          : m,
                      ),
                    }
                  })
                  if (!touched) return cache
                  return { ...cache, pages }
                },
              )
              const serverId = useCommunityStore.getState().currentServerId
              if (serverId) {
                const scope = { kind: "channel" as const, id: event.parentChannelId, serverId }
                const fallback = [...getMessageOverlay(scope).liveById.values()]
                  .find((message) => message.id === event.parentMessageId)
                if (fallback) {
                  const cached = findCachedMessage(
                    queryClient.getQueryData<PageCache>(communityKeys.channelMessages(event.parentChannelId)),
                    event.parentMessageId,
                  )
                  const source = cached?.seq !== undefined ? cached as CanonicalMessage : fallback
                  useMessageStreamStore.getState().dispatch(scope, {
                    type: "liveRefreshed",
                    message: {
                      ...source,
                      thread: { id: event.channel.id, name: event.channel.name, messageCount: 0 },
                    },
                  })
                }
              }
            }
          } else {
            // child_update — sync counts/name on the parent message's thread
            // indicator if the update carries them.
            const changes = event.changes
            if (changes.messageCount !== undefined || changes.name !== undefined) {
              queryClient.setQueryData<PageCache>(
                communityKeys.channelMessages(event.parentChannelId),
                (cache) => {
                  if (!cache) return cache
                  let touched = false
                  const pages = cache.pages.map((p) => {
                    if (!p.messages.some((m) => m.thread?.id === event.channelId)) return p
                    touched = true
                    return {
                      ...p,
                      messages: p.messages.map((m) =>
                        m.thread?.id === event.channelId
                          ? {
                            ...m,
                            thread: {
                              ...m.thread,
                              ...(changes.name !== undefined ? { name: changes.name } : {}),
                              ...(changes.messageCount !== undefined
                                ? { messageCount: changes.messageCount }
                                : {}),
                            },
                          }
                          : m,
                      ),
                    }
                  })
                  if (!touched) return cache
                  return { ...cache, pages }
                },
              )
              const serverId = useCommunityStore.getState().currentServerId
              if (serverId) {
                const scope = { kind: "channel" as const, id: event.parentChannelId, serverId }
                const fallback = [...getMessageOverlay(scope).liveById.values()]
                  .find((message) => message.thread?.id === event.channelId)
                if (fallback?.thread) {
                  const cached = findCachedMessage(
                    queryClient.getQueryData<PageCache>(communityKeys.channelMessages(event.parentChannelId)),
                    fallback.id,
                  )
                  const source = cached?.seq !== undefined ? cached as CanonicalMessage : fallback
                  useMessageStreamStore.getState().dispatch(scope, {
                    type: "liveRefreshed",
                    message: {
                      ...source,
                      thread: {
                        ...(source.thread ?? fallback.thread),
                        ...(changes.name !== undefined ? { name: changes.name } : {}),
                        ...(changes.messageCount !== undefined ? { messageCount: changes.messageCount } : {}),
                      },
                    },
                  })
                }
              }
            }
          }
          cbs.onChildChannel?.(event)
          return
        }

        // ── Server ──────────────────────────────────────────────────────
        case "community:server.update":
        case "community:server.delete": {
          if (event.type === "community:server.update") {
            queryClient.setQueryData<ServerDetail | undefined>(
              communityKeys.server(event.serverId),
              (prev) =>
                prev
                  ? {
                    ...prev,
                    name: event.changes.name ?? prev.name,
                    description: event.changes.description ?? prev.description,
                    // #8: icon can be explicitly cleared (null). `??` treats
                    // null the same as undefined, which would keep the old
                    // icon after a removal — check `undefined` explicitly.
                    icon:
                      event.changes.icon !== undefined
                        ? event.changes.icon
                        : prev.icon,
                  }
                  : prev,
            )
            queryClient.setQueryData<ServersResponse | undefined>(
              communityKeys.servers(),
              (prev) =>
                prev
                  ? {
                    ...prev,
                    servers: prev.servers.map((s) =>
                      s.id === event.serverId
                        ? {
                          ...s,
                          ...(event.changes.name ? { name: event.changes.name, initial: avatarInitial(event.changes.name) } : {}),
                          ...(event.changes.icon !== undefined ? { icon: event.changes.icon ?? null } : {}),
                        }
                        : s,
                    ),
                  }
                  : prev,
            )
          } else {
            // Refresh the rail LIST only (drop the deleted server). `exact`
            // so this doesn't cascade-refetch every other server's nested
            // detail subtree; the deleted server's own subtree is cleared by
            // the removeQueries below.
            void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true })
            queryClient.removeQueries({ queryKey: communityKeys.server(event.serverId) })
            // #10: if the deleted server is the one the viewer is looking at,
            // the store pointers now dangle — reset them so the UI drops back
            // to a safe default instead of rendering a ghost server/channel.
            const store = useCommunityStore.getState()
            useMessageStreamStore.getState().removeServer(event.serverId)
            if (store.currentServerId === event.serverId) {
              store.setCurrentServerId(null)
              store.setCurrentChannelId(null)
            }
          }
          cbs.onServer?.(event)
          return
        }

        // ── Channels / categories → refetch the server detail ───────────
        case "community:channel.create":
        case "community:channel.update":
        case "community:channel.delete":
        case "community:channel.reorder":
        case "community:category.create":
        case "community:category.update":
        case "community:category.delete":
        case "community:category.reorder": {
          // #3: on channel.delete, evict every channel-scoped cache before
          // invalidating the server. Without this the messages/pins/threads/
          // forum-posts caches for the dead channel linger forever — a
          // subsequent same-id revive (rare, but the server can reuse ids)
          // would surface stale rows.
          if (event.type === "community:channel.delete") {
            useMessageStreamStore.getState().removeScope({
              kind: "channel",
              id: event.channelId,
              serverId: event.serverId,
            })
            queryClient.removeQueries({
              queryKey: communityKeys.channelMessages(event.channelId),
            })
            queryClient.removeQueries({
              queryKey: communityKeys.pins(event.channelId),
            })
            queryClient.removeQueries({
              queryKey: communityKeys.threads(event.channelId),
            })
            queryClient.removeQueries({
              queryKey: communityKeys.forumPosts(event.channelId),
            })
            // When a child (forum_post / thread) is deleted, refresh the
            // PARENT's list so the deleted card disappears from the feed on
            // every client. Absent on older events / top-level channels.
            if (event.parentChannelId) {
              void queryClient.invalidateQueries({
                queryKey: communityKeys.forumPosts(event.parentChannelId),
              })
              void queryClient.invalidateQueries({
                queryKey: communityKeys.threads(event.parentChannelId),
              })
            }
          }
          if ("serverId" in event) {
            void queryClient.invalidateQueries({ queryKey: communityKeys.server(event.serverId) })
          }
          if (event.type.startsWith("community:channel.")) {
            cbs.onChannel?.(event as CommunityChannelCreate | CommunityChannelUpdate | CommunityChannelDelete | CommunityChannelReorder)
          } else {
            cbs.onCategory?.(event as CommunityCategoryCreate | CommunityCategoryUpdate | CommunityCategoryDelete | CommunityCategoryReorder)
          }
          return
        }

        // ── Channel membership (private channels) ────────────────────────
        // Re-run the viewer-scoped server tree so the sidebar gains/loses the
        // private channel. On REMOVE for the viewer, evict that channel's
        // scoped caches so no private content lingers locally (mirrors the
        // channel.delete eviction above).
        case "community:channel.member_add":
        case "community:channel.member_remove": {
          if (
            event.type === "community:channel.member_remove" &&
            event.userId === viewerUserIdRef.current
          ) {
            useMessageStreamStore.getState().removeScope({
              kind: "channel",
              id: event.channelId,
              serverId: event.serverId,
            })
            queryClient.removeQueries({ queryKey: communityKeys.channelMessages(event.channelId) })
            queryClient.removeQueries({ queryKey: communityKeys.pins(event.channelId) })
            queryClient.removeQueries({ queryKey: communityKeys.threads(event.channelId) })
            queryClient.removeQueries({ queryKey: communityKeys.forumPosts(event.channelId) })
          }
          void queryClient.invalidateQueries({ queryKey: communityKeys.server(event.serverId) })
          // Refetch the channel roster so an open private-channel Members drawer
          // (and the manage-members dialog) reflect the add/remove live.
          void queryClient.invalidateQueries({ queryKey: communityKeys.channelMembers(event.channelId) })
          // The addable-members candidate pool is the complement of the roster —
          // a peer's add/remove changes it too, so an open add dialog doesn't
          // offer a just-added member (whose Add would 400) or hide a removed one.
          void queryClient.invalidateQueries({ queryKey: communityKeys.channelAddableMembers(event.channelId) })
          // A forum_post's "Add participant" emits this same MEMBER_ADD event —
          // its Members panel is the participant set, so refetch it too. No-op
          // for a plain channel (participants query disabled there).
          void queryClient.invalidateQueries({ queryKey: communityKeys.threadParticipants(event.channelId) })
          return
        }

        // ── Members ─────────────────────────────────────────────────────
        case "community:member.join":
        case "community:member.leave":
        case "community:member.update": {
          const key = communityKeys.members(event.serverId)
          if (event.type === "community:member.join") {
            queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
              key,
              (cache) => patchCacheJoin(cache, event),
            )
          } else if (event.type === "community:member.leave") {
            queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
              key,
              (cache) => patchCacheLeave(cache, event),
            )
            // If the leaver is the viewer (kick from another tab / owner
            // cascade), the viewer's server rail is stale — invalidate it
            // so the layout's eject effect can detect the drop and route
            // the user away from the now-forbidden URL.
            if (event.userId === viewerUserIdRef.current) {
              useMessageStreamStore.getState().removeServer(event.serverId)
              // Rail LIST only (the layout's eject effect reads it to route the
              // kicked viewer away). `exact` so a kick doesn't cascade-refetch
              // every server's nested detail subtree.
              void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true })
            }
          } else {
            queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
              key,
              (cache) => patchCacheUpdate(cache, event),
            )
            // A self-rename carries `userId` + `changes.nickname` — patch
            // every cached message list's `authorName` snapshot for that
            // author. A role-only change has no `userId`/`nickname`, so
            // this is a no-op for that case.
            if (event.userId && event.changes.nickname) {
              const userId = event.userId
              const newName = event.changes.nickname
              for (const cacheEntry of queryClient.getQueryCache().findAll({
                predicate: (q) =>
                  q.queryKey[0] === "community"
                  && (q.queryKey[1] === "channel" || q.queryKey[1] === "dm")
                  && q.queryKey[3] === "messages",
              })) {
                queryClient.setQueryData<PageCache | undefined>(
                  cacheEntry.queryKey,
                  (cache) => patchAuthorNameInCache(cache, userId, newName),
                )
              }
              const streamState = useMessageStreamStore.getState()
              for (const entry of streamState.entries.values()) {
                if (entry.scope.kind === "channel" && entry.scope.serverId !== event.serverId) continue
                for (const message of entry.state.liveById.values()) {
                  if (message.authorId !== userId) continue
                  useMessageStreamStore.getState().dispatch(entry.scope, {
                    type: "liveRefreshed",
                    message: { ...message, authorName: newName },
                  })
                }
              }
            }
          }
          // Membership just changed → the invite dialog's "friends who aren't
          // in this server" list is stale. Cheap invalidation because the
          // query is disabled unless the dialog is actually open.
          if (event.type !== "community:member.update") {
            void queryClient.invalidateQueries({
              queryKey: communityKeys.invitableFriends(event.serverId),
            })
          }
          cbs.onMember?.(event)
          return
        }

        // ── Friends ─────────────────────────────────────────────────────
        case "community:friend.request":
        case "community:friend.accept":
        case "community:friend.reject":
        case "community:friend.remove":
        case "community:friend.block": {
          void queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
          cbs.onFriend?.(event)
          return
        }

        // ── Message updated (friend-approval card state change) ──────────
        // Folded from the old `dm.message_updated` — keyed by `channelId` (the
        // DM's channel id). Patch the card's approval payload in the focused
        // DM cache so it re-renders in its new state without a refetch.
        case "community:message.updated": {
          if (event.channelId === sub.dmConversationId || event.channelId === sub.channelId) {
            queryClient.setQueryData<PageCache>(
              communityKeys.dmMessages(event.channelId),
              (c) => patchApprovalInCache(c, event.messageId, event.approval),
            )
            queryClient.setQueryData<PageCache>(
              communityKeys.channelMessages(event.channelId),
              (c) => patchApprovalInCache(c, event.messageId, event.approval),
            )
          }
          const overlayScopes = event.channelId === sub.dmConversationId
            ? [{ kind: "dm" as const, id: event.channelId }]
            : event.channelId === sub.channelId
              ? (() => {
                const serverId = useCommunityStore.getState().currentServerId
                return serverId
                  ? [{ kind: "channel" as const, id: event.channelId, serverId }]
                  : []
              })()
              : []
          for (const scope of overlayScopes) {
            const fallback = [...getMessageOverlay(scope).liveById.values()]
              .find((message) => message.id === event.messageId)
            if (!fallback) continue
            const key = scope.kind === "dm"
              ? communityKeys.dmMessages(event.channelId)
              : communityKeys.channelMessages(event.channelId)
            const cached = findCachedMessage(
              queryClient.getQueryData<PageCache>(key),
              event.messageId,
            )
            const source = cached?.seq !== undefined ? cached as CanonicalMessage : fallback
            useMessageStreamStore.getState().dispatch(scope, {
              type: "liveRefreshed",
              message: { ...source, approval: event.approval },
            })
          }
          // When a card resolves (accepted/denied/superseded), the friend graph
          // changed — invalidate friends + pending so the owner's lists reflect
          // it. This is the owner's only signal in the J2 tail (Alice's accept
          // dead-letters FRIEND_ACCEPT to the bot).
          if (event.approval.status !== "pending" || event.approval.waitingOn !== "you") {
            void queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
          }
          return
        }

        // ── Presence — no cache; write to WS store ──────────────────────
        case "community:presence.update": {
          useCommunityWsStore.getState().setPresence(event.userId, event.online)
          cbs.onPresence?.(event)
          return
        }

        // ── Status — no cache; write to WS store (same overlay pattern as
        // presence above, see plans/profile-card.md) ────────────────────
        case "community:status.update": {
          useCommunityWsStore.getState().setUserStatus(event.userId, event.statusEmoji, event.statusText)
          return
        }

        // ── Bot audit event — push into the bounded ring; the audit-log
        // hook filters + prepends into its React Query cache. ────────────
        case "community:bot.audit_event": {
          useCommunityWsStore.getState().pushBotAuditEvent({
            id: event.id,
            botId: event.botId,
            kind: event.kind,
            payload: event.payload,
            sessionId: event.sessionId ?? null,
            launchId: event.launchId ?? null,
            createdAt: event.createdAt,
          })
          return
        }

        // ── Mentions ────────────────────────────────────────────────────
        case "community:mention.create": {
          void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
          // The server rail badge counts unread mentions per server; refresh
          // it on every new mention. `exact: true` is essential: the mention
          // count lives in the `servers()` LIST query, but members/presence/
          // invites/audit-log/server(id) are all nested UNDER `servers()` in
          // the key hierarchy — a non-exact invalidate prefix-matches and
          // force-refetches that whole subtree (and invalidate overrides the
          // staleTime: Infinity those carry). With an active bot in the server,
          // every mention.create would otherwise storm-refetch all of them.
          void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true })
          cbs.onMention?.(event)
          return
        }

        // ── Machines ────────────────────────────────────────────────────
        case "community:machine.created": {
          queryClient.setQueryData<MachinesResponse | undefined>(
            communityKeys.machines(),
            (prev) => {
              if (!prev) return { machines: [event.machine] }
              const idx = prev.machines.findIndex((m) => m.id === event.machine.id)
              if (idx === -1) return { ...prev, machines: [event.machine, ...prev.machines] }
              const next = prev.machines.slice()
              next[idx] = event.machine
              return { ...prev, machines: next }
            },
          )
          useCommunityStore.getState().setPendingMachineTokenId(event.tokenId)
          cbs.onMachine?.(event)
          return
        }
        case "community:machine.status": {
          queryClient.setQueryData<MachinesResponse | undefined>(
            communityKeys.machines(),
            (prev) =>
              prev
                ? {
                  ...prev,
                  machines: prev.machines.map((m) =>
                    m.id === event.machineId
                      ? { ...m, lastSeenAt: event.lastSeenAt, status: event.status }
                      : m,
                  ),
                }
                : prev,
          )
          cbs.onMachine?.(event)
          return
        }
        case "community:machine.updated": {
          queryClient.setQueryData<MachinesResponse | undefined>(
            communityKeys.machines(),
            (prev) => {
              if (!prev) return { machines: [event.machine] }
              const idx = prev.machines.findIndex((m) => m.id === event.machine.id)
              if (idx === -1) return { ...prev, machines: [event.machine, ...prev.machines] }
              const next: CommunityMachineSummary[] = prev.machines.slice()
              next[idx] = event.machine
              return { ...prev, machines: next }
            },
          )
          cbs.onMachine?.(event)
          return
        }
        case "community:machine.removed": {
          queryClient.setQueryData<MachinesResponse | undefined>(
            communityKeys.machines(),
            (prev) =>
              prev ? { ...prev, machines: prev.machines.filter((m) => m.id !== event.machineId) } : prev,
          )
          cbs.onMachine?.(event)
          return
        }
      }
    },
    [queryClient, scheduleInboxInvalidate],
  )

  // Machines are WS-live-patched with no query refetch (see `use-machines.ts`)
  // — but that only works while THIS browser tab's own socket stays connected.
  // If the socket drops and an offline→online transition happens while it's
  // down, the event never arrives and the card is stuck stale until a full
  // page reload. Mirror `AgentProvider`'s reconnect pattern
  // (`contexts/agent-context.tsx`): resync the machines query on every
  // reconnect so a missed transition self-corrects within the reconnect
  // window instead of requiring a manual reload.
  //
  // Same rationale for the focused channel/DM message stream after Commit C:
  // the IDB persister rehydrates the cache from the last session, but the
  // socket may have dropped WS `message.create` events while we were offline
  // (or the tab was suspended). Invalidating the focused scope's message
  // query on reconnect fires a top-up refetch — TanStack re-runs every
  // page's `pageParam`, so anchor windows and newest-tail windows both
  // catch up without any client-side `?since` bookkeeping.
  //
  // Do NOT invalidate the read-state SNAPSHOT here. The snapshot hook
  // (`useChannelReadStateSnapshot`, `gcTime: 0`) latches its first resolved
  // value in a ref and deliberately never updates it during a mount — that
  // freeze is what keeps the "New" divider pinned while the watermark
  // advances. Re-fetching it can't move the divider (the ref ignores the new
  // value), but it DOES flip the hook's `isFetching` back to true, which the
  // channel/DM pages read as `lastReadMessageId: undefined` →
  // `useMessages.isLoading: true` → the whole view drops back to the loading
  // skeleton. Because `onReconnect` fires once even on a fresh page load (a
  // StrictMode / refresh double-connect makes the socket's second open run
  // it ~1.5s in), that surfaced as a SECOND skeleton flash mid-mount —
  // "skeleton → content → skeleton → scroll to the top hero" (the empty
  // round-trip also burned the message list's one-shot mount-scroll gate;
  // see `use-scroll-anchor.ts`'s re-arm-on-empty branch). Verified via live
  // Playwright page-level trace: the second skeleton window lines up exactly
  // with `readSnapshotFetching` going true at t≈1.75s. The message-query
  // invalidation below is the legitimate top-up and keeps its data on
  // screen; the divider is already correct from the first (frozen) snapshot,
  // so nothing here needs the snapshot refetched.
  const handleReconnect = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: communityKeys.machines() })
    const sub = useCommunityStore.getState().subscription
    if (sub.channelId) {
      void queryClient.invalidateQueries({
        queryKey: communityKeys.channelMessages(sub.channelId),
      })
    }
    if (sub.dmConversationId) {
      void queryClient.invalidateQueries({
        queryKey: communityKeys.dmMessages(sub.dmConversationId),
      })
      // A DM message may have arrived while offline; the DM sidebar preview /
      // unread flag is only reconciled on `message.create`, none of which land
      // during the gap. Top it up on reconnect.
      void queryClient.invalidateQueries({ queryKey: communityKeys.dms() })
    }
    // Inbox counts also need a refetch — unreads and mentions could have
    // grown while offline and the live invalidator only fires on incoming
    // `message.create` events, none of which arrive while the socket is
    // down.
    void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
    // Sidebar unread dots + rail mention badges are now driven by the live
    // `unread.bump` patch (inbox-dot-ws-driven plan) — no switch-refetch backs
    // them anymore. A bump dropped during the socket gap would leave the dot /
    // rail badge stale forever, so re-seed both on reconnect: the rail LIST
    // (`servers()`, mention counts) and the open server's detail tree
    // (`server(currentServerId)`, channel dots). `exact` on the list so it
    // doesn't cascade-refetch every server's nested detail subtree.
    void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true })
    const currentServerId = useCommunityStore.getState().currentServerId
    if (currentServerId) {
      void queryClient.invalidateQueries({
        queryKey: communityKeys.server(currentServerId),
      })
    }
    // Bot audit logs are WS-live-patched into the React Query cache; if
    // the socket dropped, any events emitted during the gap never entered
    // the store's ring and so never made it into the cache. Invalidating
    // all bot audit-log pages on reconnect lets an open modal catch up.
    void queryClient.invalidateQueries({
      queryKey: [...communityKeys.all, "bot"],
      // Fuzzy prefix match — communityKeys.botAuditLog is [all, "bot", botId, "audit-log"].
      exact: false,
    })
  }, [queryClient])
  const { send } = useUserWs(handleMessage, { onReconnect: handleReconnect })

  // Publish the send binding so free helpers (`communityWsSendTyping`) can
  // dispatch without holding a hook reference. Single-instance assumption
  // matches the "mount at tree root" contract; if a second call site invoked
  // the hook, the last one would win. Cleared on unmount.
  useEffect(() => {
    // #15: warn if a second hook instance has mounted while another is still
    // active. Two live subscribers would each publish their own `send` into
    // this module slot — the second mount overwrites the first, and the
    // first's cleanup then clears the slot mid-flight (see the `activeSend
    // === send` check below). Whoever added the second mount site should
    // co-locate them under a single root-level `useCommunityWs()` call.
    if (activeSend !== null && activeSend !== send) {
      console.warn(
        "[useCommunityWs] Multiple instances detected — mount this hook once at the tree root.",
      )
    }
    activeSend = send
    return () => {
      if (activeSend === send) activeSend = null
    }
  }, [send])

  // ── Public methods ───────────────────────────────────────────────────────

  /** Subscribe to a channel/thread/DM (writes to the Zustand store). */
  const subscribe = useCallback((target: Subscription) => {
    useCommunityStore.getState().subscribe(target)
  }, [])

  const unsubscribe = useCallback(() => {
    useCommunityStore.getState().unsubscribe()
  }, [])

  /**
   * Send a typing indicator. Client-side throttled per channelId (a DM is a
   * channel now). The DO also applies server-side dedup.
   */
  const sendTyping = useCallback(
    (target: { channelId: string }) => {
      const key = target.channelId
      if (!key) return

      const now = Date.now()
      const map = useCommunityStore.getState().lastTypingSent
      const lastSent = map.get(key) || 0
      if (now - lastSent < TYPING_INDICATOR_THROTTLE_MS) return

      // Mutate the map in place — no equality change, no re-render (nothing
      // subscribes to it). Keeping it in the store keeps the lifetime tied
      // to `reset()` on sign-out.
      map.set(key, now)
      send({ type: "community:typing.start", channelId: key })
    },
    [send],
  )

  // Cleanup: flush the inbox debounce if the hook unmounts mid-window so the
  // parent surface doesn't leave a scheduled fetch dangling.
  useEffect(() => {
    return () => {
      if (inboxDebounce.current) {
        clearTimeout(inboxDebounce.current)
        inboxDebounce.current = null
      }
    }
  }, [])

  return {
    subscribe,
    unsubscribe,
    sendTyping,
  }
}

// ── Typing indicator helpers ─────────────────────────────────────────────────

/**
 * The conversation scope key an event belongs to. Every event carries a single
 * `channelId` now (a DM is a channel), so the `dm:` / `ch:` prefix — which the
 * DM page (`dm:<id>`) and channel page (`ch:<id>`) read via
 * `useTypingUsersForScope` — is derived from the subscription: if the event's
 * channelId is the focused DM channel, it's a `dm:` scope; otherwise `ch:`.
 * Threads collapse to `ch:<channelId>`.
 */
function typingScopeKey(
  e: { channelId: string },
  sub: { channelId?: string; dmConversationId?: string },
): string {
  return e.channelId === sub.dmConversationId ? `dm:${e.channelId}` : `ch:${e.channelId}`
}

// Timer map key: one auto-expire timer per (scope, user) pair.
const timerKey = (scopeKey: string, userId: string) => `${scopeKey}|${userId}`

/**
 * Add userId to a conversation scope's typing set and start (or extend) an
 * auto-expire timer. The timer removes the user from THAT scope after
 * `TYPING_INDICATOR_TIMEOUT_MS` if no follow-up typing event arrives.
 * No-ops the set write when the user is already typing in the scope (rule 2 —
 * typing.start re-fires every ~3s).
 */
function applyTypingIndicator(scopeKey: string, userId: string, name: string | null) {
  useCommunityStore.setState((state) => {
    const tKey = timerKey(scopeKey, userId)
    const existing = state.typingTimers.get(tKey)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      useCommunityStore.setState((s) => removeTypingUser(s, scopeKey, userId))
    }, TYPING_INDICATOR_TIMEOUT_MS)
    const nextTimers = new Map(state.typingTimers)
    nextTimers.set(tKey, timer)

    const current = state.typingByScope.get(scopeKey)
    // Already typing here with the same known name — only the timer refreshed,
    // leave the name map alone (avoids a needless re-render). Otherwise (new
    // typer, or a name we didn't have before) write the entry.
    if (current?.has(userId) && current.get(userId) === name) {
      return { typingTimers: nextTimers }
    }
    const nextByScope = new Map(state.typingByScope)
    nextByScope.set(scopeKey, new Map(current ?? []).set(userId, name))
    return { typingByScope: nextByScope, typingTimers: nextTimers }
  })
}

/**
 * Immediately remove userId from a scope's typing set and cancel its pending
 * timer. Called when the user sends a message — sending is an implicit
 * typing.stop, and waiting for the 8s timeout leaves a ghost indicator hanging
 * under the message that just arrived.
 */
function clearTypingIndicator(scopeKey: string, userId: string) {
  useCommunityStore.setState((state) => {
    const tKey = timerKey(scopeKey, userId)
    const existing = state.typingTimers.get(tKey)
    if (!existing && !state.typingByScope.get(scopeKey)?.has(userId)) return {}
    if (existing) clearTimeout(existing)
    return removeTypingUser(state, scopeKey, userId)
  })
}

/**
 * Pure state patch: drop userId from `scopeKey`'s typing map (deleting the
 * scope key when it empties, to avoid unbounded Map growth) and its
 * `(scope, user)` timer. Shared by the auto-expire timer and the explicit clear.
 */
function removeTypingUser(
  state: { typingByScope: Map<string, Map<string, string | null>>; typingTimers: Map<string, ReturnType<typeof setTimeout>> },
  scopeKey: string,
  userId: string,
): Partial<{ typingByScope: Map<string, Map<string, string | null>>; typingTimers: Map<string, ReturnType<typeof setTimeout>> }> {
  const nextTimers = new Map(state.typingTimers)
  nextTimers.delete(timerKey(scopeKey, userId))
  const current = state.typingByScope.get(scopeKey)
  if (!current?.has(userId)) return { typingTimers: nextTimers }
  const nextMap = new Map(current)
  nextMap.delete(userId)
  const nextByScope = new Map(state.typingByScope)
  if (nextMap.size === 0) nextByScope.delete(scopeKey)
  else nextByScope.set(scopeKey, nextMap)
  return { typingByScope: nextByScope, typingTimers: nextTimers }
}
