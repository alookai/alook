
import { AlertCircle, ArrowUpRight, Bookmark, Check, ChevronDown, CircleCheck, Inbox, LoaderCircle, X } from "@/components/icons/lucide";
import { EntityIcon } from "../entity-icon"
import { ServerIcon } from "../server-icon"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollAreaContent, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { CommunityNavigationLink } from "./community-navigation-link"
import { InboxInlineReply } from "./inbox-inline-reply"
import { InboxMessagePreview, isInboxPreviewContentClick } from "./inbox-message-preview"
import { InboxUnreadOverflowIcon, useRetainedInboxCount } from "./inbox-unread-indicator"
import { DecisionCard } from "../messages/decision-card"
import type { OpenProfile } from "../social/profile-types"
import { Avatar } from "../avatar"
import { EmptyState } from "../empty-state"
import { ConversationResolutionErrorFrame } from "../channels/conversation-resolution-error-frame"
import type { InboxFriendRequest, InboxTodo, InboxUnreadMessagesInput, Marked, Mention, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import { formatMessageTime } from "@/lib/community/format-time"
import type { ActionableFriendRequest } from "@/hooks/community/use-friend-request-action-state"
import type { InboxChannelReadAction } from "@/hooks/community/use-inbox-channel-messages"
import { selectUnreadPresentation } from "@/hooks/community/unread-presentation"
import { tid } from "@/lib/community/testids"
import type { CommunityProfile } from "@/lib/community/models/people"
import { useCanonicalCategoriesById, useCanonicalIdentitiesByUserId, useCanonicalServersById, useChannelsByIds, useDmProjection } from "@/lib/community-db/projections"
import type { EntityKind } from "@/lib/community/models/navigation"
import { cn } from "@/lib/utils"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { avatarInitial } from "@/lib/community/avatar"
import { MESSAGE_GROUPED_ROW_PADDING_PX } from "@/lib/community/message-list-items"
import styles from "./community-inbox-popover.module.css"
import indicatorStyles from "./inbox-unread-indicator.module.css"
import {
  memo,
  useId,
  useMemo,
  useState,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react"

type UnreadChannel = UnreadServer["channels"][number]
type UnreadChild = UnreadChannel["children"][number]
export type InboxTab = "unreads" | "todo" | "marked"

function focusedScrollTargetInside(container: HTMLElement): HTMLElement | null {
  const active = container.ownerDocument.activeElement
  if (!(active instanceof HTMLElement) || !container.contains(active)) return null
  if (!active.matches("input, textarea, [contenteditable='true']")) return null
  const enclosing =
    active.closest<HTMLElement>('[data-slot="inbox-card-footer"]')
    ?? active.closest<HTMLElement>('[data-slot="inbox-reply-composer"]')
    ?? active.closest<HTMLElement>("form")
  return enclosing && container.contains(enclosing) ? enclosing : active
}

function scrollTargetIntoContainer(container: HTMLElement, target: HTMLElement, margin = 12) {
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  if (containerRect.height <= 0 || targetRect.height <= 0) return
  const bottomLimit = containerRect.bottom - margin
  const topLimit = containerRect.top + margin
  if (targetRect.bottom > bottomLimit) {
    container.scrollTop += targetRect.bottom - bottomLimit
  } else if (targetRect.top < topLimit) {
    container.scrollTop -= topLimit - targetRect.top
  }
}

function InboxScrollBody({
  tab,
  getScrollOffset,
  onScrollOffsetChange,
  children,
}: {
  tab: InboxTab
  getScrollOffset?: (tab: InboxTab) => number
  onScrollOffsetChange?: (tab: InboxTab, scrollTop: number) => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pointerScrollRef = useRef(false)
  const transientScrollRef = useRef(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const restore = () => {
      const focused = focusedScrollTargetInside(element)
      if (focused) {
        const beforeScrollTop = element.scrollTop
        scrollTargetIntoContainer(element, focused)
        if (element.scrollTop !== beforeScrollTop) {
          onScrollOffsetChange?.(tab, element.scrollTop)
        }
        return
      }
      if (getScrollOffset) element.scrollTop = getScrollOffset(tab)
    }
    if (getScrollOffset) element.scrollTop = getScrollOffset(tab)
    const window = element.ownerDocument.defaultView
    const ResizeObserverConstructor = window?.ResizeObserver
    const observer = ResizeObserverConstructor
      ? new ResizeObserverConstructor(restore)
      : null
    let observing = false
    let settled = !getScrollOffset
    const attachObserver = () => {
      if (!observer || observing) return
      observing = true
      observer.observe(element)
      if (contentRef.current) observer.observe(contentRef.current)
    }
    const detachObserver = () => {
      if (!observer || !observing) return
      observing = false
      observer.disconnect()
    }
    if (!settled || focusedScrollTargetInside(element)) attachObserver()
    let secondFrame: number | null = null
    const firstFrame = getScrollOffset
      ? window?.requestAnimationFrame(() => {
        restore()
        secondFrame = window.requestAnimationFrame(() => {
          restore()
          settled = true
          if (!focusedScrollTargetInside(element)) detachObserver()
        })
      }) ?? null
      : null
    const onFocusIn = () => {
      if (focusedScrollTargetInside(element)) attachObserver()
    }
    const onFocusOut = () => {
      queueMicrotask(() => {
        if (settled && !focusedScrollTargetInside(element)) detachObserver()
      })
    }
    element.addEventListener("focusin", onFocusIn)
    element.addEventListener("focusout", onFocusOut)
    return () => {
      detachObserver()
      element.removeEventListener("focusin", onFocusIn)
      element.removeEventListener("focusout", onFocusOut)
      if (firstFrame !== null) window?.cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) window?.cancelAnimationFrame(secondFrame)
    }
  }, [getScrollOffset, onScrollOffsetChange, tab])
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const next = event.currentTarget.scrollTop
    const previous = getScrollOffset?.(tab) ?? 0
    if (
      next >= previous
      || pointerScrollRef.current
      || transientScrollRef.current
    ) {
      onScrollOffsetChange?.(tab, next)
    }
    transientScrollRef.current = false
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "].includes(event.key)) {
      transientScrollRef.current = true
    }
  }
  return (
    <ScrollAreaRoot className="h-full">
      <ScrollAreaViewport
        ref={ref}
        data-testid={tid.inboxTabScroll(tab)}
        // Column so an empty state (Caught up, No mentions) centres in the body (QA #36).
        className="flex h-full flex-col overflow-x-hidden overflow-y-auto"
        onScroll={onScroll}
        onWheel={() => { transientScrollRef.current = true }}
        onKeyDown={onKeyDown}
        onPointerDown={() => { pointerScrollRef.current = true }}
        onPointerUp={() => { pointerScrollRef.current = false }}
        onPointerCancel={() => { pointerScrollRef.current = false }}
      >
        <ScrollAreaContent ref={contentRef} className="flex min-h-full flex-1 flex-col px-3 pb-3">{children}</ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollBar orientation="vertical" />
    </ScrollAreaRoot>
  )
}

function InboxCountBadge({ count, shown, descriptionId }: { count: number; shown: boolean; descriptionId: string }) {
  const description = shown ? `${count} unread ${count === 1 ? "message" : "messages"}` : undefined
  return (
    <span role={shown ? "img" : undefined} aria-label={description} data-slot="inbox-disclosure-count"
      className={cn(indicatorStyles.countMotion, "grid size-full shrink-0 place-items-center text-xs font-semibold leading-none tabular-nums")}>
      {count > 99 ? <InboxUnreadOverflowIcon /> : count}
      {description && <span id={descriptionId} className="sr-only">{description}</span>}
    </span>
  )
}

const identityActionClassName = "group/inbox-identity flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-sm transition-[color,background-color,transform] duration-150 active:scale-[0.99] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
const expandedIdentityActionClassName = "-mx-1.5 px-1.5 py-0.5 hover:bg-foreground/5"
const cardActionClassName = "size-11 shrink-0 sm:size-8"

function InboxIconAction({ children, className, compact, ...props }:
  Omit<ComponentProps<typeof Button>, "className" | "size" | "variant"> & { className?: string; compact?: boolean }
) {
  return (
    <Button {...props} variant="ghost" size="icon" className={cn(
      compact ? "size-11 shrink-0 bg-transparent!" : `${cardActionClassName} rounded-full max-sm:bg-transparent! hover:bg-foreground/7 dark:hover:bg-foreground/9`,
      "focus-visible:ring-inset",
      className,
    )}>
      <span aria-hidden="true" data-slot="inbox-action-visual" className={cn(
        "pointer-events-none grid place-items-center rounded-full transition-colors duration-150 motion-reduce:transition-none",
        compact ? "size-7 group-hover/button:bg-accent" : "max-sm:size-7 max-sm:group-hover/button:bg-foreground/10",
      )}>
        {children}
      </span>
    </Button>
  )
}

function useInboxCardDirectory(channelIds: readonly string[]) {
  const directChannels = useChannelsByIds(channelIds, channelIds.length > 0)
  const parentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const channel of directChannels.values()) {
      if (channel.parentChannelId && !directChannels.has(channel.parentChannelId)) ids.add(channel.parentChannelId)
    }
    return [...ids]
  }, [directChannels])
  const parentChannels = useChannelsByIds(parentIds, parentIds.length > 0)
  const channels = useMemo(() => {
    if (parentChannels.size === 0) return directChannels
    const merged = new Map(directChannels)
    for (const [id, row] of parentChannels) merged.set(id, row)
    return merged
  }, [directChannels, parentChannels])
  const categories = useCanonicalCategoriesById()
  const servers = useCanonicalServersById()
  const dms = useDmProjection({ includePresence: false })
  return useMemo(() => ({ channels, categories, servers, dms }), [categories, channels, dms, servers])
}

type InboxCardDirectory = ReturnType<typeof useInboxCardDirectory>

function channelLocation(directory: InboxCardDirectory, channelId: string, parentChannelId?: string | null) {
  const channel = directory.channels.get(channelId)
  const parent = channel?.parentChannelId ?? parentChannelId
  if (parent) return directory.channels.get(parent)?.name
  return channel?.categoryId ? directory.categories.get(channel.categoryId)?.name : undefined
}

function entityIconClassName(kind?: EntityKind) {
  return kind === "forum" || kind === "thread" ? "size-3.5 shrink-0" : "h-3.5 w-auto shrink-0"
}

function InboxServerCardIdentity({ server, name, kind, location, showJumpCue }: {
  server: Pick<UnreadServer, "serverId" | "serverName" | "serverIcon">
  name: string
  kind?: EntityKind
  location?: string | null
  showJumpCue?: boolean
}) {
  const context = location ? `${server.serverName} › ${location}` : server.serverName
  return (
    <>
      <ServerIcon id={server.serverId} name={server.serverName} initial={avatarInitial(server.serverName)}
        icon={server.serverIcon} size={32} className="shrink-0 rounded-lg" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1 text-sm font-medium leading-snug text-foreground">
          {kind === "forum" || kind === "thread" ? (
            <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
              <EntityIcon kind={kind} className="size-3.5" />
            </span>
          ) : (
            <EntityIcon kind={kind} className="h-3.5 w-auto shrink-0 text-muted-foreground" />
          )}
          <span className="truncate" title={name}>{name}</span>
          {showJumpCue && (
            <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/inbox-identity:opacity-100 group-focus-visible/inbox-identity:opacity-100 motion-reduce:transition-none" />
          )}
        </span>
        <span className="block truncate text-xs leading-snug text-muted-foreground" title={context}>{context}</span>
      </span>
    </>
  )
}

function InboxDmCardIdentity({ name, avatar, userId, discriminator, showJumpCue }: {
  name: string
  avatar: string
  userId: string
  discriminator?: string
  showJumpCue?: boolean
}) {
  return (
    <>
      <Avatar label={avatar} seed={userId} size={32} />
      <span className="flex min-w-0 flex-1 items-baseline gap-1">
        <span className="min-w-0 truncate text-sm font-medium leading-snug text-foreground" title={name}>
          {name}{discriminator && <span className="ml-1 text-xs font-normal text-muted-foreground">#{discriminator}</span>}
        </span>
        {showJumpCue && (
          <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0 self-center text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/inbox-identity:opacity-100 group-focus-visible/inbox-identity:opacity-100 motion-reduce:transition-none" />
        )}
      </span>
    </>
  )
}

function InboxCard({ testId, identity, actions, feedback, footer, animatePreview, children }: {
  testId: string
  identity: ReactNode
  actions: ReactNode
  feedback?: ReactNode
  footer?: ReactNode
  animatePreview?: boolean
  children: ReactNode
}) {
  const stickyRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const hasPreview = Boolean(children)
  const hasBody = hasPreview || Boolean(feedback) || Boolean(footer)

  useLayoutEffect(() => {
    const sticky = stickyRef.current
    const preview = previewRef.current
    if (!sticky || !preview) return
    const updateHeight = () => preview.style.setProperty("--inbox-sticky-header-height", `${sticky.offsetHeight}px`)
    updateHeight()
    const ResizeObserverConstructor = sticky.ownerDocument.defaultView?.ResizeObserver
    if (!ResizeObserverConstructor) return
    const observer = new ResizeObserverConstructor(updateHeight)
    observer.observe(sticky, { box: "border-box" })
    return () => observer.disconnect()
  }, [hasPreview])

  return (
    <article data-testid={testId} className="mb-2.5 isolate min-w-0 rounded-xl text-card-foreground">
      <div ref={stickyRef} className={hasBody ? "sticky top-0 z-10 bg-popover" : undefined}>
        <header data-slot="inbox-card-header" data-expanded={hasBody ? "true" : "false"} className={cn(
          "relative isolate flex min-w-0 items-center gap-2 overflow-clip px-3 transition-colors duration-150 motion-reduce:transition-none sm:px-3.5",
          !hasBody && "hover:text-accent-foreground before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:opacity-0 before:transition-opacity before:duration-150 hover:before:opacity-100 motion-reduce:before:transition-none",
          styles.cardSurface,
          hasBody ? "rounded-t-xl pt-1.5 pb-0 sm:pt-2.5 sm:pb-1" : "rounded-xl py-1.5 sm:py-2.5",
        )}>
          {identity}
          {actions}
        </header>
      </div>
      {hasBody && <div className={cn("min-w-0 overflow-clip rounded-b-xl pb-2", styles.cardSurface)}>
        {feedback}
        {hasPreview && <div ref={previewRef} data-slot="inbox-card-preview" className={cn(styles.preview, animatePreview && styles.previewEnter)}>{children}</div>}
        {footer && <div data-slot="inbox-card-footer" className="min-w-0 px-3 pt-2 pb-1 sm:px-3.5">{footer}</div>}
      </div>}
    </article>
  )
}

function UnreadChannelCard({ channelId, name, identityTestId, identityHref, onOpen, throughSeq = 0, unreadCount = 0, mentions, renderUnreadMessages, onMarkChannelRead, read, replyPlaceholder, replyLabel, onReply, children }: {
  channelId: string
  name: string
  identityTestId: string
  identityHref?: string
  onOpen: () => void
  throughSeq?: number
  unreadCount?: number
  mentions: Mention[]
  renderUnreadMessages: (input: InboxUnreadMessagesInput) => ReactNode
  onMarkChannelRead?: (channelId: string, throughSeq: number) => Promise<unknown>
  read?: InboxChannelReadAction
  replyPlaceholder?: string
  replyLabel?: string
  onReply?: (content: string, nonce: string) => Promise<unknown>
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const countId = `${bodyId}-count`
  const showCount = !expanded && unreadCount > 0
  const displayCount = useRetainedInboxCount(unreadCount)
  const identityElement = useRef<HTMLElement>(null)
  const hasBody = expanded || read?.status === "error"
  const identityProps = {
    ref: (element: HTMLElement | null) => { identityElement.current = element },
    "data-testid": identityTestId,
    className: cn(identityActionClassName, hasBody && expandedIdentityActionClassName),
  }
  const identity = identityHref
    ? <CommunityNavigationLink {...identityProps} href={identityHref} onActivate={onOpen}>{children}</CommunityNavigationLink>
    : <button {...identityProps} type="button" onClick={onOpen}>{children}</button>
  const pending = read?.status === "pending"
  const mark = (seq: number) => {
    if (!pending) void onMarkChannelRead?.(channelId, seq).catch(() => undefined)
  }
  return (
    <InboxCard testId={tid.inboxUnreadCard(channelId)} identity={identity} animatePreview
      actions={<div className="-me-1.5 flex shrink-0 items-center gap-0.5 sm:-me-1 sm:gap-1.5">
        <Button variant="secondary" size="icon"
          className="relative size-7 shrink-0 rounded-full max-sm:mx-2 max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-[''] focus-visible:ring-inset sm:size-8"
          data-testid={tid.inboxMarkChannelRead(channelId)}
          aria-label={`Mark ${name} read`} disabled={!onMarkChannelRead || throughSeq <= 0 || pending}
          onClick={() => mark(throughSeq)}>
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
        </Button>
        <Button variant={showCount ? "unread" : "ghost"} size="icon"
          className={cn(
            showCount
              ? "relative size-7 rounded-full max-sm:mx-2 max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-[''] sm:size-8"
              : cn(cardActionClassName, "rounded-full bg-transparent! text-muted-foreground! hover:bg-foreground/7 dark:hover:bg-foreground/9"),
            "focus-visible:ring-inset",
          )}
          data-testid={tid.inboxToggleChannel(channelId)}
          aria-label={`${expanded ? "Hide" : "Show"} unread messages in ${name}`} aria-expanded={expanded} aria-controls={bodyId}
          aria-describedby={showCount ? countId : undefined}
          onClick={() => setExpanded(value => !value)}>
          <span aria-hidden="true" data-slot="inbox-action-visual" data-unread={showCount}
            className={cn(
              "pointer-events-none",
              !showCount && "max-sm:grid max-sm:size-7 max-sm:place-items-center max-sm:rounded-full max-sm:group-hover/button:bg-foreground/10",
              styles.disclosureVisual,
              indicatorStyles.motion,
            )}>
            <InboxCountBadge count={displayCount} shown={showCount} descriptionId={countId} />
            <span data-slot="inbox-disclosure-chevron" className={indicatorStyles.iconMotion}>
              <ChevronDown isAnimated={false} className={cn("size-4", (expanded || showCount) && "rotate-180")} />
            </span>
          </span>
        </Button>
      </div>}
      feedback={read?.status === "error" && <div role="alert" className="flex items-center justify-between gap-2 px-3 pb-1 text-xs sm:px-3.5">
        <span>Couldn&apos;t update read status</span>
        <Button variant="ghost" size="sm" className="min-h-11 sm:min-h-8" aria-label={`Retry marking ${name} read`}
          onClick={() => mark(read.throughSeq)}>Retry</Button>
      </div>}
      footer={expanded && onReply && (
        <InboxInlineReply
          placeholder={replyPlaceholder ?? `Reply in #${name}…`}
          inputLabel={replyLabel ?? `Reply in #${name}`}
          inputTestId={tid.inboxReplyInput(channelId)}
          sendTestId={tid.inboxReplySend(channelId)}
          onSend={async (content, nonce) => { await onReply(content, nonce) }}
        />
      )}
    >
      {expanded && <section id={bodyId} aria-label={`Unread messages in ${name}`} className="min-w-0 px-3 sm:px-3.5"
        onClick={event => {
          if (isInboxPreviewContentClick(event)) identityElement.current?.click()
        }}>
        {renderUnreadMessages({ channelId, throughSeq, mentions })}
      </section>}
    </InboxCard>
  )
}

function AttentionLoadError({ onRetry, retrying = false }: { onRetry?: () => void; retrying?: boolean }) {
  if (onRetry) return <ConversationResolutionErrorFrame as="div" title="Couldn't load Inbox" retrying={retrying} onRetry={onRetry} />
  return <div role="alert" className="flex flex-1 flex-col"><EmptyState icon={AlertCircle} label="Couldn't load Inbox" /></div>
}

function UnreadsTab({ friendRequests, servers, dms, loading, error, retrying, onRetry, onOpenFriendRequests, onAcceptFriendRequest, onRejectFriendRequest, onRetryFriendRequest, onOpenChannel, onOpenThread, onOpenDm, renderUnreadMessages, onMarkChannelRead, onReplyChannel, onSubmitDecisionCard, viewerUserId, channelReadActions, mentions, profilesByUserId, directory, getScrollOffset, onScrollOffsetChange }: {
  friendRequests: Array<ActionableFriendRequest<InboxFriendRequest>>
  servers: UnreadServer[]
  dms: UnreadDm[]
  loading?: boolean
  error?: boolean
  retrying?: boolean
  onRetry?: () => void
  onOpenFriendRequests?: () => void
  onAcceptFriendRequest?: (request: ActionableFriendRequest<InboxFriendRequest>) => void
  onRejectFriendRequest?: (request: ActionableFriendRequest<InboxFriendRequest>) => void
  onRetryFriendRequest?: (request: ActionableFriendRequest<InboxFriendRequest>) => void
  onOpenChannel?: (
    server: UnreadServer,
    channel: UnreadChannel,
    directUnreadVisible: boolean,
  ) => void
  onOpenThread: (server: UnreadServer, parent: UnreadChannel, child: UnreadChild) => void
  onOpenDm?: (dm: UnreadDm) => void
  renderUnreadMessages?: (input: InboxUnreadMessagesInput) => ReactNode
  onMarkChannelRead?: (channelId: string, throughSeq: number) => Promise<unknown>
  onReplyChannel?: (channelId: string, content: string, nonce: string) => Promise<unknown>
  onSubmitDecisionCard?: (channelId: string, messageId: string, content: string, nonce: string) => Promise<{ replyToId: string | null }>
  viewerUserId?: string | null
  channelReadActions?: ReadonlyMap<string, InboxChannelReadAction>
  mentions: Mention[]
  profilesByUserId: ReadonlyMap<string, CommunityProfile>
  directory: InboxCardDirectory
  getScrollOffset?: (tab: InboxTab) => number
  onScrollOffsetChange?: (tab: InboxTab, scrollTop: number) => void
}) {
  const renderMessages = renderUnreadMessages ?? ((input: InboxUnreadMessagesInput) => (
    <div data-testid={tid.inboxUnreadMessages(input.channelId)}>
      {input.mentions.length === 0
        ? <p className="py-1.5 text-sm text-muted-foreground">No unread messages</p>
        : <div data-slot="inbox-card-messages" className={cn("flex min-w-0 flex-col", !input.continuation && "gap-1")}>
            {input.mentions.map((mention, index) => <InboxMessagePreview key={mention.id} message={{ ...mention.m, grouped: false }}
              continuation={input.continuation}
              first={index === 0}
              viewerUserId={input.viewerUserId}
              onSubmitDecisionCard={input.onSubmitDecisionCard
                ? (messageId, content, nonce) => input.onSubmitDecisionCard!(input.channelId, messageId, content, nonce)
                : undefined}
              paddingBottom={input.continuation && index < input.mentions.length - 1 ? MESSAGE_GROUPED_ROW_PADDING_PX : undefined}
              testId={tid.inboxMention(mention.id)} />)}
          </div>}
    </div>
  ))
  const visibleDms = dms
  const visibleServers = servers.map((server) => ({
    server,
    channels: server.channels.map((channel) => {
      return {
        channel,
        directVisible: channel.hasDirectUnread !== false,
        children: channel.children,
      }
    }).filter((group) => group.directVisible || group.children.length > 0),
  })).filter((group) => group.channels.length > 0)
  const nothingUnread = friendRequests.length === 0 && visibleServers.length === 0 && visibleDms.length === 0
  return (
    <InboxScrollBody tab="unreads" getScrollOffset={getScrollOffset} onScrollOffsetChange={onScrollOffsetChange}>
      {loading && nothingUnread && <InboxUnreadsSkeleton />}
      {error && nothingUnread && <AttentionLoadError onRetry={onRetry} retrying={retrying} />}
      {!loading && !error && nothingUnread && <EmptyState icon={Inbox} label="Caught up" />}
      {friendRequests.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          <div className="px-1 text-xs font-medium text-muted-foreground">
            Friend requests — {friendRequests.length}
          </div>
          {friendRequests.map((item) => {
            const request = item.row
            if (request.pendingIdentity) {
              return (
                <div key={request.id} data-testid={tid.inboxFriendRequest(request.id)} className={cn("flex items-center gap-2 rounded-xl px-3 py-2.5 sm:px-3.5", styles.cardSurface)}>
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton className="h-3.5 w-28 rounded" />
                  </div>
                </div>
              )
            }
            const profile = readCommunityProfile(
              profilesByUserId.get(request.userId),
              request.userId,
            )
            const pending = item.status === "pending"
            return (
              <div
                key={request.id}
                data-testid={tid.inboxFriendRequest(request.id)}
                aria-busy={pending || undefined}
                className={cn("rounded-xl px-3 py-1.5 transition-colors duration-150 motion-reduce:transition-none sm:px-3.5 sm:py-2", styles.cardSurface)}
              >
                <div className="flex items-center gap-2">
                  <button
                    data-testid={tid.inboxFriendRequestOpen(request.id)}
                    onClick={onOpenFriendRequests}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                  >
                    <Avatar label={profile.avatar} seed={request.userId} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{profile.name}{profile.discriminator && <span className="ml-1 text-xs font-normal tracking-wide text-muted-foreground">#{profile.discriminator}</span>}</span>
                    </span>
                  </button>
                  <div className="-me-1.5 flex shrink-0 gap-0.5 sm:-me-1">
                    <InboxIconAction compact
                      data-testid={tid.inboxFriendRequestAccept(request.id)}
                      disabled={pending}
                      onClick={() => onAcceptFriendRequest?.(item)}
                      aria-label={`Accept ${profile.name}'s friend request`}
                      className="text-muted-foreground"
                    >
                      {pending && item.action === "accept"
                        ? <LoaderCircle className="size-4 animate-spin" />
                        : <Check className={pending ? "size-4" : "size-4 text-status-online"} />}
                    </InboxIconAction>
                    <InboxIconAction compact
                      data-testid={tid.inboxFriendRequestReject(request.id)}
                      disabled={pending}
                      onClick={() => onRejectFriendRequest?.(item)}
                      aria-label={`Reject ${profile.name}'s friend request`}
                      className="text-muted-foreground"
                    >
                      {pending && item.action === "reject"
                        ? <LoaderCircle className="size-4 animate-spin" />
                        : <X className="size-4 text-destructive" />}
                    </InboxIconAction>
                  </div>
                </div>
                {item.error && (
                  <div role="status" aria-live="polite" className="mt-1 flex items-center justify-end gap-2 text-xs text-destructive">
                    <span>{item.error}</span>
                    <Button variant="ghost" size="sm" className="min-h-11 min-w-11 font-medium underline sm:min-h-0 sm:min-w-0" onClick={() => onRetryFriendRequest?.(item)}>Retry</Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {visibleDms.map(dm => {
        const profile = readCommunityProfile(profilesByUserId.get(dm.otherUserId), dm.otherUserId)
        return <UnreadChannelCard key={dm.channelId} channelId={dm.channelId} name={profile.name} throughSeq={dm.lastUnreadSeq} unreadCount={dm.unreadCount}
          identityTestId={tid.inboxUnreadDm(dm.channelId)} identityHref={`/c/me/${encodeURIComponent(dm.channelId)}`} onOpen={() => onOpenDm?.(dm)}
          mentions={mentions.filter(mention => mention.channelId === dm.channelId)}
          renderUnreadMessages={input => renderMessages({ ...input, continuation: true, viewerUserId, onSubmitDecisionCard })}
          onMarkChannelRead={onMarkChannelRead} read={channelReadActions?.get(dm.channelId)}
          replyPlaceholder={`Reply to ${profile.name}…`}
          replyLabel={`Reply to ${profile.name}`}
          onReply={onReplyChannel ? (content, nonce) => onReplyChannel(dm.channelId, content, nonce) : undefined}>
          <InboxDmCardIdentity name={profile.name} avatar={profile.avatar} userId={dm.otherUserId} discriminator={profile.discriminator} showJumpCue />
        </UnreadChannelCard>
      })}
      {visibleServers.flatMap(({ server, channels }) => channels.flatMap(({ channel, directVisible, children }) => [
        ...(directVisible ? [<UnreadChannelCard key={channel.channelId} channelId={channel.channelId} name={channel.channelName} throughSeq={channel.lastUnreadSeq} unreadCount={channel.unreadCount}
          identityTestId={tid.inboxUnreadChannel(channel.channelId)} onOpen={() => onOpenChannel?.(server, channel, true)}
          mentions={mentions.filter(mention => mention.channelId === channel.channelId)}
          renderUnreadMessages={input => renderMessages({
            ...input,
            viewerUserId,
            onSubmitDecisionCard,
            openForumPosts: channel.forumOpeners?.length ? new Map(channel.forumOpeners.map(opener => [
              opener.openerMessageId, () => onOpenThread(server, channel, opener),
            ])) : undefined,
          })}
          onMarkChannelRead={onMarkChannelRead} read={channelReadActions?.get(channel.channelId)}
          replyPlaceholder={`Reply in #${channel.channelName}…`}
          replyLabel={`Reply in #${channel.channelName}`}
          onReply={onReplyChannel && channel.type !== "forum" ? (content, nonce) => onReplyChannel(channel.channelId, content, nonce) : undefined}>
          <InboxServerCardIdentity server={server} name={channel.channelName} kind={channel.type}
            location={channelLocation(directory, channel.channelId)} showJumpCue />
        </UnreadChannelCard>] : []),
        ...children.map(child => <UnreadChannelCard key={child.channelId} channelId={child.channelId} name={child.channelName} throughSeq={child.lastUnreadSeq} unreadCount={child.unreadCount}
          identityTestId={tid.inboxUnreadChild(child.channelId)} onOpen={() => onOpenThread(server, channel, child)}
          mentions={mentions.filter(mention => mention.channelId === child.channelId)}
          renderUnreadMessages={input => renderMessages({ ...input, viewerUserId, onSubmitDecisionCard })}
          onMarkChannelRead={onMarkChannelRead} read={channelReadActions?.get(child.channelId)}
          replyPlaceholder={`Reply in #${child.channelName}…`}
          replyLabel={`Reply in #${child.channelName}`}
          onReply={onReplyChannel ? (content, nonce) => onReplyChannel(child.channelId, content, nonce) : undefined}>
          <InboxServerCardIdentity server={server} name={child.channelName} kind={child.type} location={channel.channelName} showJumpCue />
        </UnreadChannelCard>),
      ]))}
    </InboxScrollBody>
  )
}

function TodoTab({
  todos,
  viewerUserId,
  loading,
  error,
  retrying,
  onRetry,
  onOpenTodo,
  onSubmitTodo,
  onReplyTodo,
  onDismissTodo,
  onOpenProfile,
  profilesByUserId,
  directory,
  getScrollOffset,
  onScrollOffsetChange,
}: {
  todos: InboxTodo[]
  viewerUserId?: string | null
  loading?: boolean
  error?: boolean
  retrying?: boolean
  onRetry?: () => void
  onOpenTodo?: (todo: InboxTodo) => void
  onSubmitTodo?: (todo: InboxTodo, content: string, nonce: string) => Promise<{ replyToId: string | null }>
  onReplyTodo?: (todo: InboxTodo, content: string, nonce: string) => Promise<{ replyToId: string | null }>
  onDismissTodo?: (todo: InboxTodo) => void
  onOpenProfile?: OpenProfile
  profilesByUserId: ReadonlyMap<string, CommunityProfile>
  directory: InboxCardDirectory
  getScrollOffset?: (tab: InboxTab) => number
  onScrollOffsetChange?: (tab: InboxTab, scrollTop: number) => void
}) {
  const peersByChannel = new Map(directory.dms?.map(dm => [dm.id, dm]))
  const replyTodoHandler = onReplyTodo ?? onSubmitTodo
  return (
    <InboxScrollBody tab="todo" getScrollOffset={getScrollOffset} onScrollOffsetChange={onScrollOffsetChange}>
      {loading && todos.length === 0 && <InboxRowsSkeleton />}
      {error && todos.length === 0 && <AttentionLoadError onRetry={onRetry} retrying={retrying} />}
      {!loading && !error && todos.length === 0 && <EmptyState icon={CircleCheck} label="No pending questions" />}
      {todos.length > 0 && (
        <div className="flex flex-col gap-3 pb-3">
          {todos.map((todo) => {
            const card = todo.m.decisionCard
            if (!card) return null
            const channel = directory.channels.get(todo.channelId)
            const server = todo.serverId ? directory.servers.get(todo.serverId) : undefined
            const peer = peersByChannel.get(todo.channelId)
            const channelName = peer?.name ?? channel?.name ?? todo.channel
            const serverName = server?.name ?? todo.server
            const location = todo.serverId ? channelLocation(directory, todo.channelId, todo.parentChannelId) : undefined
            const context = todo.serverId
              ? (location ? `${serverName} › ${location}` : serverName)
              : "Direct Messages"
            const authorProfile = todo.m.authorId ? profilesByUserId.get(todo.m.authorId) : undefined
            const authorName = authorProfile?.name ?? todo.m.authorName ?? ""
            const timestamp = todo.m.createdAt ? formatMessageTime(todo.m.createdAt) : ""
            const open = onOpenTodo ? () => onOpenTodo(todo) : undefined
            const channelKind = channel?.type === "dm" ? undefined : channel?.type
            const sourceHeader = (
              <div className="-mx-2 -my-1 flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  data-testid={tid.inboxTodoOpen(todo.messageId)}
                  onClick={open}
                  disabled={!open}
                  className="group/todo-source flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors duration-150 hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none sm:min-h-0"
                >
                  {todo.serverId ? (
                    <ServerIcon
                      id={todo.serverId}
                      name={serverName}
                      initial={avatarInitial(serverName)}
                      icon={server?.icon}
                      size={32}
                      className="shrink-0 rounded-lg"
                    />
                  ) : (
                    <Avatar
                      label={peer?.avatar ?? avatarInitial(channelName)}
                      seed={peer?.userId ?? todo.channelId}
                      size={32}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1 text-sm font-medium leading-snug text-foreground">
                      {todo.serverId && (
                        <EntityIcon
                          kind={channelKind}
                          className={cn(entityIconClassName(channelKind), "text-muted-foreground")}
                        />
                      )}
                      <span className="truncate" title={channelName}>{channelName}</span>
                      {todo.serverId && authorName && (
                        <>
                          <span aria-hidden="true" className="shrink-0 text-xs font-normal text-muted-foreground">·</span>
                          <span className="truncate text-xs font-normal text-muted-foreground" title={authorName}>{authorName}</span>
                        </>
                      )}
                    </span>
                    <span className="flex min-w-0 items-center gap-1 text-xs leading-snug text-muted-foreground">
                      <span className="truncate" title={context}>{context}</span>
                      {timestamp && (
                        <>
                          <span aria-hidden="true" className="shrink-0">·</span>
                          <span className="shrink-0" suppressHydrationWarning>{timestamp}</span>
                        </>
                      )}
                    </span>
                  </span>
                  {open && (
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/todo-source:text-foreground"
                    />
                  )}
                </button>
                {onDismissTodo && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid={tid.inboxTodoDismiss(todo.messageId)}
                    aria-label="Dismiss question"
                    title="Dismiss"
                    onClick={() => onDismissTodo(todo)}
                    className="size-9 shrink-0 rounded-lg text-muted-foreground hover:bg-accent/80 hover:text-foreground sm:size-7"
                  >
                    <X className="size-3.5" />
                  </Button>
                )}
              </div>
            )
            const replyFooter = replyTodoHandler ? (
              <InboxInlineReply
                placeholder="Or reply directly…"
                inputLabel="Reply directly to question"
                inputTestId={tid.inboxTodoReplyInput(todo.messageId)}
                sendTestId={tid.inboxTodoReplySend(todo.messageId)}
                onSend={async (content, nonce) => {
                  const receipt = await replyTodoHandler(todo, content, nonce)
                  if (receipt.replyToId !== todo.messageId) {
                    return {
                      accepted: false,
                      error: "Could not link your reply to this question — reload and try again.",
                    }
                  }
                }}
              />
            ) : undefined
            return (
              <article key={todo.id} data-testid={tid.inboxTodoCard(todo.messageId)} className="min-w-0">
                <DecisionCard
                  messageId={todo.messageId}
                  card={card}
                  authorId={todo.m.authorId}
                  viewerUserId={viewerUserId ?? undefined}
                  header={sourceHeader}
                  footer={replyFooter}
                  className="my-0"
                  onSubmit={onSubmitTodo
                    ? (_messageId, content, nonce) => onSubmitTodo(todo, content, nonce)
                    : undefined}
                  onOpenProfile={onOpenProfile}
                />
              </article>
            )
          })}
        </div>
      )}
    </InboxScrollBody>
  )
}

function MarkedTab({ marked, loading, error, retrying, onRetry, onOpenMarked, onUnmark, directory, getScrollOffset, onScrollOffsetChange }: {
  marked: Marked[]
  loading?: boolean
  error?: boolean
  retrying?: boolean
  onRetry?: () => void
  onOpenMarked?: (m: Marked) => void
  onUnmark?: (messageId: string) => void
  directory: InboxCardDirectory
  getScrollOffset?: (tab: InboxTab) => number
  onScrollOffsetChange?: (tab: InboxTab, scrollTop: number) => void
}) {
  const peersByChannel = new Map(directory.dms?.map(dm => [dm.id, dm]))
  return (
    <InboxScrollBody tab="marked" getScrollOffset={getScrollOffset} onScrollOffsetChange={onScrollOffsetChange}>
      {loading && marked.length === 0 && <InboxRowsSkeleton />}
      {error && marked.length === 0 && <AttentionLoadError onRetry={onRetry} retrying={retrying} />}
      {!loading && !error && marked.length === 0 && <EmptyState icon={Bookmark} label="No marked messages" />}
      {marked.map(mk => {
        const channel = directory.channels.get(mk.channelId)
        const server = mk.serverId ? directory.servers.get(mk.serverId) : undefined
        const peer = peersByChannel.get(mk.channelId)
        const name = peer?.name ?? channel?.name ?? mk.channel
        const open = onOpenMarked ? () => onOpenMarked(mk) : undefined
        const isOtherAuthorInDm = !mk.serverId && Boolean(peer?.userId && mk.m.authorId && mk.m.authorId !== peer.userId)
        const continuation = !mk.serverId && !isOtherAuthorInDm
        return (
          <InboxCard key={mk.id} testId={tid.inboxMarkedCard(mk.id)}
            identity={<button type="button" className={cn(identityActionClassName, expandedIdentityActionClassName)} onClick={open}>
              {mk.serverId
                ? <InboxServerCardIdentity name={name} kind={channel?.type === "dm" ? undefined : channel?.type}
                    location={channelLocation(directory, mk.channelId, mk.parentChannelId)}
                    server={{ serverId: mk.serverId, serverName: server?.name ?? mk.server, serverIcon: server?.icon }}
                    showJumpCue={Boolean(open)} />
                : <InboxDmCardIdentity name={name} avatar={peer?.avatar ?? avatarInitial(name)}
                    userId={peer?.userId ?? mk.channelId} discriminator={peer?.discriminator}
                    showJumpCue={Boolean(open)} />}
            </button>}
            actions={onUnmark && <InboxIconAction aria-label="Unmark" title="Unmark"
              data-testid={tid.inboxUnmark(mk.m.id)}
              className="-me-1.5 text-muted-foreground hover:text-foreground sm:-me-1"
              onClick={() => onUnmark(mk.m.id)}>
              <X className="size-4" />
            </InboxIconAction>}
          >
            <div data-slot="inbox-card-messages" className="min-w-0 px-3 sm:px-3.5">
              <InboxMessagePreview message={{ ...mk.m, grouped: false }} continuation={continuation} first onOpen={open} />
            </div>
          </InboxCard>
        )
      })}
    </InboxScrollBody>
  )
}

export const InboxPopover = memo(function InboxPopover({
  friendRequests = [],
  unreads,
  unreadDms,
  mentions,
  todos = [],
  todosTruncated = false,
  marked,
  markedLoading,
  markedError,
  markedRetrying,
  onRetryMarked,
  loading,
  attentionError,
  attentionRetrying,
  onRetryAttention,
  hasProjectedUnreads,
  hasProjectedMentions,
  hasOutstandingFriendRequest = friendRequests.length > 0,
  viewerUserId,
  onOpenFriendRequests,
  onAcceptFriendRequest,
  onRejectFriendRequest,
  onRetryFriendRequest,
  onOpenChannel,
  onOpenThread,
  onOpenDm,
  onOpenTodo,
  onSubmitTodo,
  onReplyTodo,
  onDismissTodo,
  onOpenProfile,
  onOpenMarked,
  onUnmark,
  onMarkedTabSelected,
  onMarkAllRead,
  activeTab,
  onActiveTabChange,
  getScrollOffset,
  onScrollOffsetChange,
  renderUnreadMessages,
  onMarkChannelRead,
  onReplyChannel,
  onSubmitDecisionCard,
  channelReadActions,
  surface = "desktop",
}: {
  friendRequests?: Array<ActionableFriendRequest<InboxFriendRequest>>
  unreads: UnreadServer[]
  unreadDms: UnreadDm[]
  mentions: Mention[]
  todos?: InboxTodo[]
  todosTruncated?: boolean
  marked: Marked[]
  markedLoading?: boolean
  markedError?: boolean
  markedRetrying?: boolean
  onRetryMarked?: () => void
  loading?: boolean
  attentionError?: boolean
  attentionRetrying?: boolean
  onRetryAttention?: () => void
  hasProjectedUnreads: boolean
  hasProjectedMentions: boolean
  hasOutstandingFriendRequest?: boolean
  viewerUserId?: string | null
  onOpenFriendRequests?: () => void
  onAcceptFriendRequest?: (request: ActionableFriendRequest<InboxFriendRequest>) => void
  onRejectFriendRequest?: (request: ActionableFriendRequest<InboxFriendRequest>) => void
  onRetryFriendRequest?: (request: ActionableFriendRequest<InboxFriendRequest>) => void
  onOpenChannel?: (
    server: UnreadServer,
    channel: UnreadChannel,
    directUnreadVisible: boolean,
  ) => void
  onOpenThread?: (server: UnreadServer, parent: UnreadChannel, child: UnreadChild) => void
  onOpenDm?: (dm: UnreadDm) => void
  onOpenTodo?: (todo: InboxTodo) => void
  onSubmitTodo?: (todo: InboxTodo, content: string, nonce: string) => Promise<{ replyToId: string | null }>
  onReplyTodo?: (todo: InboxTodo, content: string, nonce: string) => Promise<{ replyToId: string | null }>
  onDismissTodo?: (todo: InboxTodo) => void
  onOpenProfile?: OpenProfile
  onOpenMarked?: (m: Marked) => void
  onUnmark?: (messageId: string) => void

  onMarkedTabSelected?: () => void
  onMarkAllRead?: () => void
  activeTab?: InboxTab
  onActiveTabChange?: (tab: InboxTab) => void
  getScrollOffset?: (tab: InboxTab) => number
  onScrollOffsetChange?: (tab: InboxTab, scrollTop: number) => void
  renderUnreadMessages?: (input: InboxUnreadMessagesInput) => ReactNode
  onMarkChannelRead?: (channelId: string, throughSeq: number) => Promise<unknown>
  onReplyChannel?: (channelId: string, content: string, nonce: string) => Promise<unknown>
  onSubmitDecisionCard?: (channelId: string, messageId: string, content: string, nonce: string) => Promise<{ replyToId: string | null }>
  channelReadActions?: ReadonlyMap<string, InboxChannelReadAction>
  surface?: "desktop" | "mobile" | "extension"
}) {
  const channelIds = useMemo(() => {
    const ids = new Set<string>()
    for (const server of unreads) {
      for (const channel of server.channels) {
        ids.add(channel.channelId)
        for (const child of channel.children) {
          ids.add(child.channelId)
          if (child.parentChannelId) ids.add(child.parentChannelId)
        }
        for (const opener of channel.forumOpeners ?? []) {
          ids.add(opener.channelId)
          if (opener.parentChannelId) ids.add(opener.parentChannelId)
        }
      }
    }
    for (const dm of unreadDms) ids.add(dm.channelId)
    for (const mention of mentions) if (mention.channelId) ids.add(mention.channelId)
    for (const todo of todos) {
      ids.add(todo.channelId)
      if (todo.parentChannelId) ids.add(todo.parentChannelId)
    }
    for (const item of marked) {
      ids.add(item.channelId)
      if (item.parentChannelId) ids.add(item.parentChannelId)
    }
    return [...ids]
  }, [marked, mentions, todos, unreadDms, unreads])
  const profileIds = useMemo(() => {
    const ids = new Set<string>()
    for (const req of friendRequests) if (req.row.userId) ids.add(req.row.userId)
    for (const dm of unreadDms) if (dm.otherUserId) ids.add(dm.otherUserId)
    for (const mention of mentions) if (mention.m.authorId) ids.add(mention.m.authorId)
    for (const todo of todos) if (todo.m.authorId) ids.add(todo.m.authorId)
    for (const item of marked) if (item.m.authorId) ids.add(item.m.authorId)
    return [...ids]
  }, [friendRequests, marked, mentions, todos, unreadDms])
  const profilesByUserId = useCanonicalIdentitiesByUserId(profileIds, profileIds.length > 0)
  const directory = useInboxCardDirectory(channelIds)
  const hasUnreads = hasProjectedUnreads
  const hasMentions = hasProjectedMentions
  const showUnreadDot = selectUnreadPresentation({
    accountUnread: hasUnreads || hasOutstandingFriendRequest,
  }).showDot
  const hasMessageUnread = hasUnreads || hasMentions
  return (
    <Tabs
      defaultValue="unreads"
      value={activeTab}
      onValueChange={(value) => {
        const tab = value as InboxTab
        onActiveTabChange?.(tab)
        if (tab === "marked") onMarkedTabSelected?.()
      }}
      className={surface === "desktop" ? "flex h-160 flex-col" : "flex h-full min-h-0 flex-col"}
    >
      <div className="flex items-center gap-2 px-3 pt-4">
        <Inbox className="size-5" />
        <h2 className="flex-1 text-lg font-semibold">Inbox</h2>
        {onMarkAllRead && (
          <Button variant="ghost" size="sm"
            onClick={onMarkAllRead}
            disabled={!hasMessageUnread}
            className="h-auto p-0 text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
          >
            Mark all read
          </Button>
        )}
      </div>
      <TabsList data-testid={tid.inboxTabList} variant="line" className="mt-3 w-full border-b border-border px-3">
        <TabsTrigger value="unreads">
          <span className="inline-flex items-center gap-1">
            Unreads
            {showUnreadDot && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
        </TabsTrigger>
        <TabsTrigger value="todo">
          <span className="inline-flex items-center gap-1.5">
            Todo
            {todos.length > 0 && (
              <span
                aria-label={`${todos.length}${todosTruncated ? "+" : ""} pending ${todos.length === 1 && !todosTruncated ? "question" : "questions"}`}
                className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[11px] font-semibold leading-none text-primary-foreground"
              >
                {todosTruncated ? `${todos.length}+` : todos.length}
              </span>
            )}
          </span>
        </TabsTrigger>
        <TabsTrigger value="marked">Marked</TabsTrigger>
      </TabsList>
      <TabsContent value="unreads" className="min-h-0 flex-1 pt-3">
        <UnreadsTab
          friendRequests={friendRequests}
          servers={unreads}
          dms={unreadDms}
          mentions={mentions}
          renderUnreadMessages={renderUnreadMessages}
          onMarkChannelRead={onMarkChannelRead}
          onReplyChannel={onReplyChannel}
          onSubmitDecisionCard={onSubmitDecisionCard}
          viewerUserId={viewerUserId}
          channelReadActions={channelReadActions}
          loading={loading}
          error={attentionError}
          retrying={attentionRetrying}
          onRetry={onRetryAttention}
          onOpenFriendRequests={onOpenFriendRequests}
          onAcceptFriendRequest={onAcceptFriendRequest}
          onRejectFriendRequest={onRejectFriendRequest}
          onRetryFriendRequest={onRetryFriendRequest}
          onOpenChannel={onOpenChannel}
          onOpenThread={onOpenThread ?? (() => {})}
          onOpenDm={onOpenDm}
          profilesByUserId={profilesByUserId}
          directory={directory}
          getScrollOffset={getScrollOffset}
          onScrollOffsetChange={onScrollOffsetChange}
        />
      </TabsContent>
      <TabsContent value="todo" className="min-h-0 flex-1 pt-3">
        <TodoTab
          todos={todos}
          viewerUserId={viewerUserId}
          loading={loading}
          error={attentionError}
          retrying={attentionRetrying}
          onRetry={onRetryAttention}
          onOpenTodo={onOpenTodo}
          onSubmitTodo={onSubmitTodo}
          onReplyTodo={onReplyTodo}
          onDismissTodo={onDismissTodo}
          onOpenProfile={onOpenProfile}
          profilesByUserId={profilesByUserId}
          directory={directory}
          getScrollOffset={getScrollOffset}
          onScrollOffsetChange={onScrollOffsetChange}
        />
      </TabsContent>
      <TabsContent value="marked" className="min-h-0 flex-1 pt-3">
        <MarkedTab marked={marked} loading={markedLoading} error={markedError} retrying={markedRetrying} onRetry={onRetryMarked} onOpenMarked={onOpenMarked} onUnmark={onUnmark} directory={directory} getScrollOffset={getScrollOffset} onScrollOffsetChange={onScrollOffsetChange} />
      </TabsContent>
    </Tabs>
  )
})

function InboxRowsSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className={cn("rounded-xl px-3 py-2.5 sm:px-3.5", styles.cardSurface)}>
          <div className="flex items-center gap-2">
            <Skeleton className={cn("size-8 shrink-0", i % 2 === 0 ? "rounded-full" : "rounded-lg")} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-2/5 rounded" />
              {i % 2 !== 0 && <Skeleton className="h-2.5 w-1/4 rounded" />}
            </div>
          </div>
          <div className="mt-2 flex items-start gap-2">
            <div className="w-8 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-11/12 rounded" />
              <Skeleton className="h-3 w-3/5 rounded" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function InboxUnreadsSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className={cn("flex items-center gap-2 rounded-xl px-3 py-2.5 sm:px-3.5", styles.cardSurface)}>
          <Skeleton className={cn("size-8 shrink-0", i < 2 ? "rounded-full" : "rounded-lg")} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 rounded" style={{ width: `${42 + ((i * 17) % 28)}%` }} />
            {i >= 2 && <Skeleton className="h-2.5 w-1/4 rounded" />}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Skeleton className="size-7 rounded-full" />
            <Skeleton className="size-5 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  )
}
