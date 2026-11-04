"use client"

import { Button } from "@/components/ui/button"
import { messagePreviewText } from "@alook/shared"
import { useAtom, useCreateAtom, useSelector } from "@tanstack/react-store"


import { useCommunityRuntime } from "@/stores/community/runtime"
import { getQualifiedConversationScope } from "@/lib/community/conversation-entry"
import { isChannelMetadataTokenCurrent, conversationListScopeKey } from "@/lib/community/conversation-qualification"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { useCommunityRouter } from "@/contexts/community/module-route"
import { toast } from "sonner"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CommunityMessageResourcesSchema, CommunityResourceProfileSchema, communityMessageProfileIds, deriveThreadName } from "@alook/shared"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { MessageRow } from "./message-row"
import { MessageShareDialog } from "./message-share-dialog"
import { ChannelIcon } from "../channels/channel-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { formatDateLabel } from "@/lib/community/format-time"
import { DateDivider } from "../dividers"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useUiHandlers } from "@/stores/community"
import {
  useAddReactionApi,
  useCreateThread,
  usePinMessage,
  useToggleMark,
  useToggleReactionApi,
  useUnpinMessage,
  type ReactionArgs,
} from "@/hooks/community/mutations"
import type { FileAttachment, ImagePreview, MessagesReadPage, Msg, RenderMsg, ReplyTarget } from "@/lib/community/models/message"
import { apiFetchCommunity, communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { isAbortError } from "@/lib/errors"
import { withConversationReadDeadline, conversationReadRetryPolicy, isConversationAnchorMissingError } from "@/lib/community/conversation-read"
import type { OpenProfile } from "@/components/community/social/profile-types"
import { useHoverCapable } from "@/hooks/use-hover-capable"
import { channelHref } from "@/lib/community/community-route"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { communityKeys } from "@/lib/query-keys"
import {
  materializeCanonicalMessage,
  materializeCanonicalMessages,
  useCanonicalMessagesById,
  useCanonicalProfilesProjection,
} from "@/lib/community-db/projections"
import {
  getCanonicalCommunityMessageResources,
  captureCommunityLiveSnapshotToken,
  assertCommunityLiveSnapshotTokenCurrent,
  publishCommunityEmbeddedMessages,
} from "@/lib/community-db/sync"


// Preview window sizing — small on purpose. The sheet is a read-only
// excerpt with just enough surrounding context to make the target message
// legible; deeper browsing happens in the underlying channel view.
const CONTEXT_LIMIT = 11

type ScopeType = "channel" | "dm"

export function openMessageContextThread({
  type,
  serverId,
  threadId,
  push,
  close,
}: {
  type: ScopeType
  serverId?: string
  threadId: string
  push: (href: string) => void
  close: () => void
}): boolean {
  if (type === "dm" || !serverId) return false
  push(channelHref(serverId, threadId))
  close()
  return true
}

// A DM (type=dm) and a thread are channel rows in the same id-space, so both
// resolve through the one canonical door — no per-type URL fork. `type` is kept
// in the signatures for call-site clarity but no longer branches the path.
function seqLookupUrl(_type: ScopeType, id: string, seq: number): string {
  return `/api/community/channels/${id}/messages/seq/${seq}`
}

function anchorFetchUrl(_type: ScopeType, id: string, anchor: string, limit: number): string {
  const base = `/api/community/channels/${id}/messages`
  return `${base}?anchor=${encodeURIComponent(anchor)}&limit=${limit}`
}

type SheetCache = {
  notFound?: boolean
  anchorId?: Msg["id"]
  proof?: ReturnType<typeof captureCommunityLiveSnapshotToken>
  messages?: Pick<Msg, "id">[]
}

export function messageContextIdQueryFn(type: ScopeType, channelId: string, seq: number, queryClient: ReturnType<typeof useQueryClient>) {
  return ({ signal }: { signal?: AbortSignal } = {}) => withConversationReadDeadline(signal, async signal => {
    const proof = captureCommunityLiveSnapshotToken(queryClient, channelId)
    await proof.registry?.ready
    assertCommunityLiveSnapshotTokenCurrent(queryClient, proof, signal)
    try {
      const result = await apiFetch<Pick<Msg, "id">>(seqLookupUrl(type, channelId, seq), communityRequestOptions(queryClient, proof, signal))
      assertCommunityLiveSnapshotTokenCurrent(queryClient, proof, signal)
      return { id: result.id, proof, notFound: false }
    } catch (error) {
      assertCommunityLiveSnapshotTokenCurrent(queryClient, proof, signal)
      if (error instanceof ApiError && error.status === 404) return { id: undefined, proof, notFound: true }
      throw error
    }
  })
}

export function messageContextQueryFn(
  type: ScopeType,
  channelId: string,
  targetId: string,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  return ({ signal }: { signal?: AbortSignal } = {}): Promise<SheetCache> => withConversationReadDeadline(signal, async signal => {
    const publicationToken = captureCommunityLiveSnapshotToken(queryClient, channelId)
    const registry = publicationToken.registry
    const assert = () => assertCommunityLiveSnapshotTokenCurrent(queryClient, publicationToken, signal)
    await registry?.ready
    assert()
    await registry?.collections.messages.preload()
    assert()
    let page: MessagesReadPage
    try { page = await apiFetchCommunity<MessagesReadPage>(
      anchorFetchUrl(type, channelId, targetId, CONTEXT_LIMIT),
      { signal, assertActive: assert }, publicationToken,
    )
    } catch (error) {
      assert()
      if (isConversationAnchorMissingError(error)) return { notFound: true, proof: publicationToken }
      throw error
    }
    const messages = (page.messages ?? []).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    await publishCommunityEmbeddedMessages(queryClient, {
      entries: [...messages, ...(page.relatedMessages ?? [])].map((message) => ({ channelId, message })),
      profiles: page.profiles,
      proof: { token: publicationToken, signal },
    })
    assert()
    return { notFound: false, proof: publicationToken, anchorId: targetId, messages: messages.map(({ id }) => ({ id })) }
  })
}



/**
 * Sidecar preview shown when the user clicks a `#NUMBER` ref pointing at a
 * message that isn't in the currently loaded window. Fetches ~5 above / target
 * / ~5 below via the anchor endpoint, renders them as a plain vertical stack
 * of `<MessageRow>` rows (no MessageList, no virtualization), centers the
 * target row on open.
 *
 * **Self-contained transport, shared entities** — the sheet keeps its own
 * anchor/window Query payload, but publishes embedded messages into the same
 * canonical account collection as every other surface. Actions patch those
 * canonical rows without injecting mid-history items into the main list's
 * pagination cache.
 *
 * Reply is the ONE action that intentionally crosses back into the main
 * surface: since the sheet has no composer, clicking Reply on a preview row
 * closes the sheet and seeds the main channel's composer with that target,
 * via the `onReply` prop.
 *
 * Retry is disabled — the sheet only shows server-persisted messages, never
 * failed optimistic rows.
 */
export function MessageContextSheet(props: React.ComponentProps<typeof MessageContextSheetContent>) {
  const runtime = useCommunityRuntime()
  const client = useQueryClient()
  const ws = useSelector(runtime.ws, state => state)
  const lifecycle = useSelector(runtime.lifecycle, state => state)
  const denied = runtime.ws.actions.isChannelAccessRevoked(props.channelId, props.serverId)
  if (!props.open || !lifecycle.active || ws.profileViewerId === null || !getCommunityDbRegistry(client)) return null
  const token = captureCommunityLiveSnapshotToken(client, props.channelId)
  const scopeKey = conversationListScopeKey({ proof: token, tag: null })
  if (denied) return <CommunitySheet open onOpenChange={props.onOpenChange} title="Message"><p role="alert" className="p-4 text-sm text-muted-foreground">You can no longer read this conversation.</p></CommunitySheet>
  return <MessageContextSheetContent key={JSON.stringify([scopeKey, props.targetMessageId ?? props.targetSeq])} {...props} />
}

function MessageContextSheetContent({
  open,
  onOpenChange,
  channelId,
  serverId,
  channelLabel,
  targetSeq,
  targetMessageId,
  pinnedIds,
  onOpenProfile,
  resolveUserName,
  onReply,
  canManagePins = false,
  onOpenPinned,
  type = "channel",
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  channelId: string
  serverId?: string
  // Source channel's display name for the header — a message ref opens this
  // sheet to preview a (possibly other) channel's message in place, so the
  // header names which channel's context this is (Gus #417/#423, Alli #420).
  channelLabel?: string
  targetSeq: number | null
  targetMessageId?: string
  pinnedIds?: Set<string>
  onOpenProfile?: OpenProfile
  resolveUserName?: (userId: string) => string
  // Fired when Reply is clicked in the sheet. Parent should seed its
  // composer's replyTo state AND close the sheet — the sheet is a
  // read-only preview, replying belongs on the main surface.
  onReply?: (target: ReplyTarget) => void
  canManagePins?: boolean
  onOpenPinned?: () => void
  type?: ScopeType
}) {
  const currentUser = useCurrentUser()
  const uiHandlers = useUiHandlers()
  const queryClient = useQueryClient()
  const router = useCommunityRouter()
  const pinMessageMut = usePinMessage()
  const unpinMessageMut = useUnpinMessage()
  const createThreadMut = useCreateThread()
  const toggleMark = useToggleMark()
  const toggleReactionApi = useToggleReactionApi()
  const addReactionApi = useAddReactionApi()

  const [localAnchorId, setLocalAnchorId] = useAtom(useCreateAtom<string | null>(null))
  const [nestedId, setNestedId] = useAtom(useCreateAtom<string | null>(null))
  const requestedId = nestedId ?? targetMessageId
  const qualification = conversationListScopeKey({ proof: captureCommunityLiveSnapshotToken(queryClient, channelId), tag: null })
  const lookup = useQuery({
    queryKey: [...communityKeys.messageContext(type, channelId, targetSeq), qualification],
    enabled: open && !!channelId && !requestedId && !!targetSeq,
    queryFn: messageContextIdQueryFn(type, channelId, targetSeq!, queryClient),
    staleTime: 30_000,
    networkMode: "always",
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey: communityKeys.messageContexts(type, channelId) }).retry),
  })
  const resolved = lookup.data && isChannelMetadataTokenCurrent(lookup.data.proof) ? lookup.data : undefined
  const targetId = requestedId ?? resolved?.id
  const query = useQuery({
    queryKey: [...communityKeys.messageContext(type, channelId, targetId ?? null), qualification],
    enabled: open && !!channelId && !!targetId,
    queryFn: messageContextQueryFn(type, channelId, targetId!, queryClient),
    staleTime: 30_000,
    networkMode: "always",
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey: communityKeys.messageContexts(type, channelId) }).retry),
  })
  const cached = query.data?.proof && isChannelMetadataTokenCurrent(query.data.proof) ? query.data : undefined
  const registry = getCommunityDbRegistry(queryClient)
  const scope = getQualifiedConversationScope(queryClient, { channelId, serverId: type === "dm" ? null : serverId ?? null })
  const qualified = !!scope && !!targetId && registry?.collections.messages.get(targetId)?.channelId === channelId
  const references = useMemo(() => cached?.messages ?? (!cached && qualified && targetId ? [{ id: targetId }] : []), [cached, qualified, targetId])
  const selectedIds = useMemo(() => references.map(message => message.id), [references])
  const canonicalMessages = useCanonicalMessagesById(selectedIds)
  const selectedResources = selectedIds.map(id => { const row = registry?.collections.messages.get(id); return row?.channelId === channelId ? row : undefined })
  const graph = getCanonicalCommunityMessageResources(queryClient, selectedResources)
  const profiles = useCanonicalProfilesProjection(graph ? communityMessageProfileIds(graph.messages) : [])
  const nativeGraph = graph && CommunityMessageResourcesSchema.safeParse({ messages: graph.messages, profiles: [...profiles.resourceProfiles.values()].flatMap(profile => {
    const parsed = CommunityResourceProfileSchema.strip().safeParse(profile)
    return parsed.success ? [parsed.data] : []
  }) })
  const graphReady = !!graph && profiles.isReady && !profiles.isError && nativeGraph?.success === true
  const refetch = query.refetch
  useEffect(() => {
    if (open && cached && !cached.notFound && !graph && query.isSuccess && !query.isFetching) void refetch({ cancelRefetch: false })
  }, [open, cached, graph, query.isSuccess, query.isFetching, refetch])


  const renderRows = useMemo<RenderMsg[]>(() => {
    if (cached?.notFound) return []
    const src = materializeCanonicalMessages(references, canonicalMessages)
    // Same grouping heuristic the main list uses (adjacent same-author within
    // ~5 min → collapse header). Inlined here rather than sharing the util
    // because the excerpt is small enough that the extra dep isn't worth the
    // module coupling.
    return src.map((m, i) => {
      const prev = i > 0 ? src[i - 1] : null
      const grouped =
        !!prev &&
        prev.authorId != null &&
        prev.authorId === m.authorId &&
        prev.type === m.type &&
        !!prev.createdAt &&
        !!m.createdAt &&
        new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000
      return { ...m, grouped }
    })
  }, [canonicalMessages, references, cached])

  const anchorId = cached?.notFound ? null : localAnchorId ?? cached?.anchorId ?? targetId ?? null

  const canonicalPending = !cached?.notFound && (canonicalMessages === undefined || !graphReady)
  const anchorMissing = cached?.notFound === true || resolved?.notFound === true

  const jumpToReply = useCallback((id: string) => {
    if (references.some(message => message.id === id)) setLocalAnchorId(id)
    else { setLocalAnchorId(null); setNestedId(id) }
  }, [references, setLocalAnchorId, setNestedId])

  // ── Sheet-local actions ──────────────────────────────────────────────────
  const findMessage = useCallback(
    (id: string): Msg | undefined => {
      const transport = references.find((message) => message.id === id)
      return transport ? materializeCanonicalMessage(transport, canonicalMessages) : undefined
    },
    [canonicalMessages, references],
  )

  const runReactionIntent = useCallback((
    intent: (args: ReactionArgs) => void,
    messageId: string,
    emoji: string,
  ) => {
    const msg = findMessage(messageId)
    if (!msg) return
    const currentMe = msg.reactions?.find((r) => r.emoji === emoji)?.me ?? false
    intent({
      ...(type === "dm" ? { dmId: channelId } : { channelId }),
      messageId,
      emoji,
      userId: currentUser.id,
      currentMe,
      onError: (error) => toastApiError(error, "Failed to update reaction"),
    })
  }, [channelId, currentUser.id, findMessage, type])

  const toggleReaction = useCallback((messageId: string, emoji: string) => {
    runReactionIntent(toggleReactionApi, messageId, emoji)
  }, [runReactionIntent, toggleReactionApi])

  const addReaction = useCallback((messageId: string, emoji: string) => {
    runReactionIntent(addReactionApi, messageId, emoji)
  }, [addReactionApi, runReactionIntent])

  const onCopyId = useCallback((id: string, selectedText?: string) => {
    const m = findMessage(id)
    const content = m ? (selectedText ?? m.content ?? "") : ""
    if (content) {
      navigator.clipboard?.writeText(content)
      toast("Copied to clipboard")
    }
  }, [findMessage])

  const onReplyId = useCallback((id: string) => {
    if (!onReply) return
    const m = findMessage(id)
    if (!m) return
    onReply({
      id: m.id,
      ...(m.authorId ? { authorId: m.authorId } : {}),
      authorName: m.authorName ?? "",
      text: messagePreviewText(m),
    })
  }, [findMessage, onReply])

  // Mark works for both channel and DM (unlike pin) — the sheet's channelId is
  // the mark route's channelId for either. `useToggleMark` reads the per-message
  // marked cache (populated when this row's menu opened) to pick POST vs DELETE.
  const onMarkId = useCallback((id: string) => {
    toggleMark(channelId, id)
  }, [toggleMark, channelId])

  const onPinId = useCallback((id: string) => {
    if (type === "dm") return
    const isPinned = pinnedIds?.has(id)
    if (isPinned) {
      unpinMessageMut.mutate({ channelId, messageId: id }, {
        onSuccess: () => toast("Message unpinned"),
        onError: (e) => toastApiError(e, "Failed to unpin message"),
      })
    } else {
      pinMessageMut.mutate({ channelId, messageId: id }, {
        onSuccess: () => {
          toast("Message pinned")
          if (onOpenPinned) {
            onOpenChange(false)
            onOpenPinned()
          }
        },
        onError: (e) => toastApiError(e, "Failed to pin message"),
      })
    }
  }, [type, channelId, pinnedIds, pinMessageMut, unpinMessageMut, onOpenChange, onOpenPinned])

  const onCreateThreadId = useCallback(async (id: string) => {
    if (type === "dm") return
    if (!serverId) return
    const m = findMessage(id)
    const name = deriveThreadName(m, "channel")
    try {
      await createThreadMut.mutateAsync({ serverId, channelId, messageId: id, name })
    } catch (e) {
      if (!isAbortError(e)) toastApiError(e, "Failed to create thread")
    }
  }, [type, serverId, channelId, findMessage, createThreadMut])


  const onOpenThreadId = useCallback((threadId: string) => {
    // Sheet's Reply-style handoff: navigate the main window to the thread and
    // close the sheet in the same gesture. Falls back to a no-op in the DM
    // case (threads live inside channels, not DMs).
    openMessageContextThread({
      type,
      serverId,
      threadId,
      push: (href) => {
        uiHandlers.cancelPendingNavigation?.()
        router.push(href)
      },
      close: () => onOpenChange(false),
    })
  }, [type, router, serverId, onOpenChange, uiHandlers])

  const onPreviewImage = useCallback((image: ImagePreview) => {
    uiHandlers.previewImage?.(image)
  }, [uiHandlers])

  const onPreviewAttachment = useCallback((attachment: FileAttachment) => {
    uiHandlers.previewAttachment?.(attachment)
  }, [uiHandlers])

  // The sheet's scrollable body — we scroll INSIDE this container, not via
  // `element.scrollIntoView({block:'center'})`. `scrollIntoView` walks up to
  // the nearest scrollable ancestor and, on a first-open where the sheet is
  // still animating in, that ancestor's layout box is mid-translate — the
  // browser then computes a wrong scrollTop. Doing the math ourselves against
  // the body's `getBoundingClientRect()` sidesteps that entirely and works
  // identically on first-open and cache-hit reopen.
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !anchorId) return
    // `targetSeq` in the effect key so re-clicking the SAME pill (open→close→
    // open→same seq) still fires — closing keeps `anchorId` unchanged, so a
    // deps=[open, anchorId] effect would skip the reopen.
    let cancelled = false
    let r2 = 0
    // Two rAFs: first waits for React commit + Base UI popup layout, second
    // waits one paint after that so the popup's translate transition has been
    // ticked at least once and the scroll math resolves against the settled
    // box. Cheap (~32ms) and deterministic across first-open vs reopen.
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        if (cancelled) return
        const body = bodyRef.current
        const row = body?.querySelector<HTMLElement>(`[data-anchor-row="1"]`)
        if (!body || !row) return
        const bodyRect = body.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        const targetTop =
          body.scrollTop + (rowRect.top - bodyRect.top) - (bodyRect.height - rowRect.height) / 2
        body.scrollTop = Math.max(0, targetTop)
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(r1)
      if (r2) cancelAnimationFrame(r2)
    }
  }, [open, anchorId, targetSeq, renderRows.length])

  const displayedSeq = canonicalMessages?.get(anchorId ?? "")?.seq ?? (requestedId ? undefined : targetSeq)

  return (
    <CommunitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={channelLabel ? (
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <ChannelIcon className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{channelLabel}</span>
          <span className="shrink-0 font-mono text-base font-normal text-muted-foreground">#{displayedSeq ?? ""}</span>
        </span>
      ) : (
        <span className="font-mono text-2xl">
          <span className="text-muted-foreground">#</span>{displayedSeq ?? ""}
        </span>
      )}
      bodyRef={bodyRef}
      bodyClassName="px-4 py-3"
    >
      {!anchorMissing && !renderRows.length && !(query.isError || lookup.isError) && <ContextSkeleton />}

      {(query.isError || lookup.isError) && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Couldn&rsquo;t load the message. <Button variant="ghost" size="sm" type="button" className="h-auto p-0 underline" onClick={() => { void (lookup.isError ? lookup.refetch() : query.refetch()) }}>Retry</Button>
        </p>
      )}

      {anchorMissing && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Message not found — it may have been deleted.
        </p>
      )}

      {!anchorMissing && !canonicalPending && renderRows.length > 0 && (
        <ContextRows
          rows={renderRows}
          onJumpToId={jumpToReply}
          viewerUserId={currentUser.id}
          anchorId={anchorId}
          pinnedIds={pinnedIds}
          onOpenProfile={onOpenProfile}
          onOpenThread={type === "channel" ? onOpenThreadId : undefined}
          resolveUserName={resolveUserName}
          onToggleReaction={toggleReaction}
          onReact={addReaction}
          onReply={onReply ? onReplyId : undefined}
          onCopy={onCopyId}
          onPin={type === "channel" && canManagePins ? onPinId : undefined}
          onMark={onMarkId}
          onCreateThread={type === "channel" ? onCreateThreadId : undefined}
          onPreviewImage={onPreviewImage}
          onPreviewAttachment={onPreviewAttachment}
        />
      )}
    </CommunitySheet>
  )
}

function ContextRows({
  rows,
  onJumpToId,
  viewerUserId,
  anchorId,
  pinnedIds,
  onOpenProfile,
  onOpenThread,
  resolveUserName,
  onToggleReaction,
  onReact,
  onReply,
  onCopy,
  onPin,
  onMark,
  onCreateThread,
  onPreviewImage,
  onPreviewAttachment,
}: {
  onJumpToId: (id: string) => void
  rows: RenderMsg[]
  viewerUserId: string
  anchorId: string | null
  pinnedIds?: Set<string>
  onOpenProfile?: OpenProfile
  onOpenThread?: (threadId: string) => void
  resolveUserName?: (userId: string) => string
  onToggleReaction: (id: string, emoji: string) => void
  onReact: (id: string, emoji: string) => void
  onReply?: (id: string) => void
  onCopy: (id: string, selectedText?: string) => void
  onPin?: (id: string) => void
  onMark?: (id: string) => void
  onCreateThread?: (id: string) => void
  onPreviewImage: (image: ImagePreview) => void
  onPreviewAttachment: (attachment: FileAttachment) => void
}) {
  const hoverCapable = useHoverCapable()
  // Single-message share from the peek sheet. The sheet has no select-mode
  // context (it's a read-only preview), so Share opens the dialog directly on
  // the clicked row — via `onShareSingle`, independent of the list's select-mode
  // plumbing (Cecilia #511: share capability must not depend on it).
  const [shareTargetId, setShareTargetId] = useAtom(useCreateAtom<string | null>(null))
  const shareTarget = rows.find((row) => row.id === shareTargetId) ?? null
  const onShareSingleId = useCallback(
    (id: string) => setShareTargetId(id),
    [setShareTargetId],
  )
  return (
    <div className="flex flex-col">
      {shareTarget && (
        <MessageShareDialog m={shareTarget} open onClose={() => setShareTargetId(null)} />
      )}
      {rows.map((m, i) => {
        const isTarget = m.id === anchorId
        const prev = i > 0 ? rows[i - 1] : null
        const showDate =
          !prev ||
          (m.createdAt &&
            prev.createdAt &&
            new Date(m.createdAt).toDateString() !== new Date(prev.createdAt).toDateString())
        return (
          <div key={m.id}>
            {showDate && m.createdAt && <DateDivider label={formatDateLabel(m.createdAt)} />}
            <div data-anchor-row={isTarget ? "1" : undefined}>
              <MessageRow
                m={m}
                onJumpToId={onJumpToId}
                hoverCapable={hoverCapable}
                viewerUserId={viewerUserId}
                pinned={pinnedIds?.has(m.id)}
                highlighted={isTarget}
                onOpenThread={onOpenThread ?? (() => {})}
                onOpenProfile={onOpenProfile}
                onToggleReactionId={onToggleReaction}
                onReactId={onReact}
                onReplyId={onReply}
                onPinId={onPin}
                onMarkId={onMark}
                onCreateThreadId={onCreateThread}
                onCopyId={onCopy}
                onPreviewImage={onPreviewImage}
                onPreviewAttachment={onPreviewAttachment}
                resolveUserName={resolveUserName}
                onShareSingleId={onShareSingleId}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ContextSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-3 pt-1.5">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-24 rounded" />
              <Skeleton className="h-3 w-14 rounded" />
            </div>
            <Skeleton className="h-3.5 w-full max-w-60 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}
