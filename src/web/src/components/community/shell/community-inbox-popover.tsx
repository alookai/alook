
import { AlertCircle, Bookmark, Check, ChevronDown, Inbox, LoaderCircle, Trash2, X } from "@/components/icons/lucide";
import { EntityIcon } from "../entity-icon"
import { ServerIcon } from "../server-icon"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { CommunityNavigationLink } from "./community-navigation-link"
import { InboxMessagePreview } from "./inbox-message-preview"
import { Avatar } from "../avatar"
import { EmptyState } from "../empty-state"
import { ConversationResolutionErrorFrame } from "../channels/conversation-resolution-error-frame"
import type { InboxFriendRequest, InboxUnreadMessagesInput, Marked, Mention, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import type { ActionableFriendRequest } from "@/hooks/community/use-friend-request-action-state"
import type { InboxChannelReadAction } from "@/hooks/community/use-inbox-channel-messages"
import { selectUnreadPresentation } from "@/hooks/community/unread-presentation"
import { tid } from "@/lib/community/testids"
import type { CommunityProfile } from "@/lib/community/models/people"
import { useCanonicalCategoriesById, useCanonicalChannelsById, useCanonicalProfilesByUserId, useCanonicalServersById, useDmProjection } from "@/lib/community-db/projections"
import type { EntityKind } from "@/lib/community/models/navigation"
import { cn } from "@/lib/utils"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { avatarInitial } from "@/lib/community/avatar"
import { MESSAGE_GROUPED_ROW_PADDING_PX } from "@/lib/community/message-list-items"
import styles from "./community-inbox-popover.module.css"
import {
  useId,
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
export type InboxTab = "unreads" | "marked"

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
    if (!element || !getScrollOffset) return
    const restore = () => {
      element.scrollTop = getScrollOffset(tab)
    }
    restore()
    const window = element.ownerDocument.defaultView
    const ResizeObserverConstructor = window?.ResizeObserver
    const observer = ResizeObserverConstructor
      ? new ResizeObserverConstructor(restore)
      : null
    observer?.observe(element)
    if (contentRef.current) observer?.observe(contentRef.current)
    let secondFrame: number | null = null
    const firstFrame = window?.requestAnimationFrame(() => {
      restore()
      secondFrame = window.requestAnimationFrame(restore)
    }) ?? null
    return () => {
      observer?.disconnect()
      if (firstFrame !== null) window?.cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) window?.cancelAnimationFrame(secondFrame)
    }
  }, [getScrollOffset, tab])
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
    <div
      ref={ref}
      data-testid={tid.inboxTabScroll(tab)}
      // Column so an empty state (Caught up, No mentions) centres in the body (QA #36).
      className="flex h-full flex-col overflow-x-hidden overflow-y-auto thin-scrollbar"
      onScroll={onScroll}
      onWheel={() => { transientScrollRef.current = true }}
      onKeyDown={onKeyDown}
      onPointerDown={() => { pointerScrollRef.current = true }}
      onPointerUp={() => { pointerScrollRef.current = false }}
      onPointerCancel={() => { pointerScrollRef.current = false }}
    >
      <div ref={contentRef} className="flex flex-1 flex-col px-3 pb-3">{children}</div>
    </div>
  )
}

function InboxCountBadge({ count, descriptionId }: { count: number; descriptionId: string }) {
  const description = `${count} unread ${count === 1 ? "message" : "messages"}`
  return (
    <span role="img" aria-label={description}
      className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground">
      {count}
      <span id={descriptionId} className="sr-only">{description}</span>
    </span>
  )
}

const identityActionClassName = "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md text-left text-sm transition-transform duration-150 active:scale-[0.99] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
const cardActionClassName = "size-11 shrink-0 sm:size-8"
const unreadChannelActionClassName = "text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent"

function InboxIconAction({ children, className, visualClassName, compact, mobileRestingTint, ...props }:
  Omit<ComponentProps<typeof Button>, "className" | "size" | "variant"> & { className?: string; visualClassName?: string; compact?: boolean; mobileRestingTint?: boolean }
) {
  return (
    <Button {...props} variant="ghost" size="icon" className={cn(
      compact ? "size-11 shrink-0 bg-transparent!" : `${cardActionClassName} max-sm:bg-transparent!`,
      "focus-visible:ring-inset",
      className,
    )}>
      <span aria-hidden="true" data-slot="inbox-action-visual" className={cn(
        "pointer-events-none grid place-items-center rounded-lg transition-colors duration-150 motion-reduce:transition-none",
        compact ? "size-7 group-hover/button:bg-accent" : "max-sm:size-7 max-sm:group-hover/button:bg-accent",
        mobileRestingTint && "max-sm:group-enabled/button:bg-accent",
        visualClassName,
      )}>
        {children}
      </span>
    </Button>
  )
}

function useInboxCardDirectory() {
  const channels = useCanonicalChannelsById()
  const categories = useCanonicalCategoriesById()
  const servers = useCanonicalServersById()
  const dms = useDmProjection()
  return { channels, categories, servers, dms }
}

type InboxCardDirectory = ReturnType<typeof useInboxCardDirectory>

function channelLocation(directory: InboxCardDirectory, channelId: string, parentChannelId?: string | null) {
  const channel = directory.channels.get(channelId)
  const parent = channel?.parentChannelId ?? parentChannelId
  if (parent) return directory.channels.get(parent)?.name
  return channel?.categoryId ? directory.categories.get(channel.categoryId)?.name : undefined
}

function InboxServerCardIdentity({ server, name, kind, location }: {
  server: Pick<UnreadServer, "serverId" | "serverName" | "serverIcon">
  name: string
  kind?: EntityKind
  location?: string | null
}) {
  const context = location ? `${server.serverName} › ${location}` : server.serverName
  return (
    <>
      <ServerIcon id={server.serverId} name={server.serverName} initial={avatarInitial(server.serverName)}
        icon={server.serverIcon} className="shrink-0 rounded-lg" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1 font-medium">
          <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
            <EntityIcon kind={kind} className="size-4" />
          </span>
          <span className="truncate" title={name}>{name}</span>
        </span>
        <span className="block truncate text-xs text-muted-foreground" title={context}>{context}</span>
      </span>
    </>
  )
}

function InboxDmCardIdentity({ name, avatar, userId, discriminator }: {
  name: string
  avatar: string
  userId: string
  discriminator?: string
}) {
  return (
    <>
      <Avatar label={avatar} seed={userId} />
      <span className="min-w-0 flex-1 truncate font-medium" title={name}>
        {name}{discriminator && <span className="ml-1 text-xs text-muted-foreground">#{discriminator}</span>}
      </span>
    </>
  )
}

function InboxCard({ testId, identity, actions, feedback, children }: {
  testId: string
  identity: ReactNode
  actions: ReactNode
  feedback?: ReactNode
  children: ReactNode
}) {
  const stickyRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const hasPreview = Boolean(children)
  const hasBody = hasPreview || Boolean(feedback)

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
    <article data-testid={testId} className="mb-2 isolate min-w-0 text-card-foreground">
      <div ref={stickyRef} className={hasBody ? "sticky top-0 z-10 bg-popover" : undefined}>
        <header data-slot="inbox-card-header" className={cn(
          "relative isolate flex min-w-0 items-center gap-2 overflow-clip p-2 transition-colors duration-150 hover:text-accent-foreground motion-reduce:transition-none sm:px-4",
          "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:opacity-0 before:transition-opacity before:duration-150 hover:before:opacity-100 motion-reduce:before:transition-none",
          styles.cardSurface,
          hasBody ? "rounded-t-lg" : "rounded-lg",
        )}>
          {identity}
          {actions}
        </header>
        {hasBody && <div aria-hidden="true" data-slot="inbox-card-divider" className="h-px bg-border" />}
      </div>
      {hasBody && <div className={cn("min-w-0 overflow-clip rounded-b-lg", styles.cardSurface)}>
        {feedback}
        {hasPreview && <div ref={previewRef} data-slot="inbox-card-preview" className={styles.preview}>{children}</div>}
      </div>}
    </article>
  )
}

function UnreadChannelCard({ channelId, name, throughSeq = 0, unreadCount = 0, mentions, renderUnreadMessages, onMarkChannelRead, read, children }: {
  channelId: string
  name: string
  throughSeq?: number
  unreadCount?: number
  mentions: Mention[]
  renderUnreadMessages: (input: InboxUnreadMessagesInput) => ReactNode
  onMarkChannelRead?: (channelId: string, throughSeq: number) => Promise<unknown>
  read?: InboxChannelReadAction
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const countId = `${bodyId}-count`
  const showCount = !expanded && unreadCount > 0
  const pending = read?.status === "pending"
  const mark = (seq: number) => {
    if (!pending) void onMarkChannelRead?.(channelId, seq).catch(() => undefined)
  }
  return (
    <InboxCard testId={tid.inboxUnreadCard(channelId)} identity={children}
      actions={<div className="-me-2 flex shrink-0 items-center sm:-me-4">
        <InboxIconAction mobileRestingTint className={cn(unreadChannelActionClassName, "bg-accent")}
          data-testid={tid.inboxMarkChannelRead(channelId)}
          aria-label={`Mark ${name} read`} disabled={!onMarkChannelRead || throughSeq <= 0 || pending}
          onClick={() => mark(throughSeq)}>
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
        </InboxIconAction>
        <InboxIconAction
          className={cn(unreadChannelActionClassName, "w-auto min-w-11 px-1 sm:w-auto sm:min-w-8",
            "aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:aria-expanded:bg-accent hover:aria-expanded:text-foreground")}
          visualClassName="max-sm:w-auto max-sm:min-w-7"
          data-testid={tid.inboxToggleChannel(channelId)}
          aria-label={`${expanded ? "Hide" : "Show"} unread messages in ${name}`} aria-expanded={expanded} aria-controls={bodyId}
          aria-describedby={showCount ? countId : undefined}
          onClick={() => setExpanded(value => !value)}>
          {showCount ? <InboxCountBadge count={unreadCount} descriptionId={countId} />
            : <ChevronDown className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />}
        </InboxIconAction>
      </div>}
      feedback={read?.status === "error" && <div role="alert" className="flex items-center justify-between gap-2 px-2 pb-2 text-xs">
        <span>Couldn&apos;t update read status</span>
        <Button variant="ghost" size="sm" className="min-h-11 sm:min-h-8" aria-label={`Retry marking ${name} read`}
          onClick={() => mark(read.throughSeq)}>Retry</Button>
      </div>}
    >
      {expanded && <section id={bodyId} aria-label={`Unread messages in ${name}`} className="min-w-0 px-2 sm:px-4">
        {renderUnreadMessages({ channelId, throughSeq, mentions })}
      </section>}
    </InboxCard>
  )
}

function AttentionLoadError({ onRetry, retrying = false }: { onRetry?: () => void; retrying?: boolean }) {
  if (onRetry) return <ConversationResolutionErrorFrame as="div" title="Couldn't load Inbox" retrying={retrying} onRetry={onRetry} />
  return <div role="alert" className="flex flex-1 flex-col"><EmptyState icon={AlertCircle} label="Couldn't load Inbox" /></div>
}

function UnreadsTab({ friendRequests, servers, dms, loading, error, retrying, onRetry, onOpenFriendRequests, onAcceptFriendRequest, onRejectFriendRequest, onRetryFriendRequest, onOpenChannel, onOpenThread, onOpenDm, onOpenMention, renderUnreadMessages, onMarkChannelRead, channelReadActions, mentions, profilesByUserId, directory, getScrollOffset, onScrollOffsetChange }: {
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
  onOpenMention?: (mention: Mention) => void
  renderUnreadMessages?: (input: InboxUnreadMessagesInput) => ReactNode
  onMarkChannelRead?: (channelId: string, throughSeq: number) => Promise<unknown>
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
        ? <p className="p-2 text-sm text-muted-foreground">No unread messages</p>
        : <div data-slot="inbox-card-messages" className={cn("flex min-w-0 flex-col", !input.continuation && "gap-2")}>
            {input.mentions.map((mention, index) => <InboxMessagePreview key={mention.id} message={{ ...mention.m, grouped: false }}
              continuation={input.continuation}
              paddingBottom={input.continuation && index < input.mentions.length - 1 ? MESSAGE_GROUPED_ROW_PADDING_PX : undefined}
              testId={tid.inboxMention(mention.id)} onOpen={onOpenMention ? () => onOpenMention(mention) : undefined} />)}
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
        <div className="mb-3">
          <div className="px-2 pb-1 text-xs font-semibold text-muted-foreground">
            Friend requests — {friendRequests.length}
          </div>
          {friendRequests.map((item) => {
            const request = item.row
            if (request.pendingIdentity) {
              return (
                <div key={request.id} data-testid={tid.inboxFriendRequest(request.id)} className="flex items-center gap-2 rounded-md px-2 py-2">
                  <Skeleton className="size-7 shrink-0 rounded-full" />
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
                className="rounded-md px-2 py-2 hover:bg-accent"
              >
                <div className="flex items-center gap-2">
                  <button
                    data-testid={tid.inboxFriendRequestOpen(request.id)}
                    onClick={onOpenFriendRequests}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
                  >
                    <Avatar label={profile.avatar} seed={request.userId} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{profile.name}{profile.discriminator && <span className="ml-1 text-xs font-normal tracking-wide text-muted-foreground">#{profile.discriminator}</span>}</span>
                    </span>
                  </button>
                  <div className="flex shrink-0 gap-1">
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
          mentions={mentions.filter(mention => mention.channelId === dm.channelId)}
          renderUnreadMessages={input => renderMessages({ ...input, continuation: true })}
          onMarkChannelRead={onMarkChannelRead} read={channelReadActions?.get(dm.channelId)}>
          <CommunityNavigationLink data-testid={tid.inboxUnreadDm(dm.channelId)} href={`/c/me/${encodeURIComponent(dm.channelId)}`}
            onActivate={() => onOpenDm?.(dm)} className={identityActionClassName}>
            <InboxDmCardIdentity name={profile.name} avatar={profile.avatar} userId={dm.otherUserId} discriminator={profile.discriminator} />
          </CommunityNavigationLink>
        </UnreadChannelCard>
      })}
      {visibleServers.flatMap(({ server, channels }) => channels.flatMap(({ channel, directVisible, children }) => [
        ...(directVisible ? [<UnreadChannelCard key={channel.channelId} channelId={channel.channelId} name={channel.channelName} throughSeq={channel.lastUnreadSeq} unreadCount={channel.unreadCount}
          mentions={mentions.filter(mention => mention.channelId === channel.channelId)}
          renderUnreadMessages={input => renderMessages({
            ...input,
            openForumPosts: channel.forumOpeners?.length ? new Map(channel.forumOpeners.map(opener => [
              opener.openerMessageId, () => onOpenThread(server, channel, opener),
            ])) : undefined,
          })}
          onMarkChannelRead={onMarkChannelRead} read={channelReadActions?.get(channel.channelId)}>
          <button type="button" data-testid={tid.inboxUnreadChannel(channel.channelId)}
            onClick={() => onOpenChannel?.(server, channel, true)} className={identityActionClassName}>
            <InboxServerCardIdentity server={server} name={channel.channelName} kind={channel.type}
              location={channelLocation(directory, channel.channelId)} />
          </button>
        </UnreadChannelCard>] : []),
        ...children.map(child => <UnreadChannelCard key={child.channelId} channelId={child.channelId} name={child.channelName} throughSeq={child.lastUnreadSeq} unreadCount={child.unreadCount}
          mentions={mentions.filter(mention => mention.channelId === child.channelId)} renderUnreadMessages={renderMessages}
          onMarkChannelRead={onMarkChannelRead} read={channelReadActions?.get(child.channelId)}>
          <button type="button" data-testid={tid.inboxUnreadChild(child.channelId)}
            onClick={() => onOpenThread(server, channel, child)} className={identityActionClassName}>
            <InboxServerCardIdentity server={server} name={child.channelName} kind={child.type} location={channel.channelName} />
          </button>
        </UnreadChannelCard>),
      ]))}
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
        return (
          <InboxCard key={mk.id} testId={tid.inboxMarkedCard(mk.id)}
            identity={<button type="button" className={identityActionClassName} onClick={open}>
              {mk.serverId
                ? <InboxServerCardIdentity name={name} kind={channel?.type === "dm" ? undefined : channel?.type}
                    location={channelLocation(directory, mk.channelId, mk.parentChannelId)}
                    server={{ serverId: mk.serverId, serverName: server?.name ?? mk.server, serverIcon: server?.icon }} />
                : <InboxDmCardIdentity name={name} avatar={peer?.avatar ?? avatarInitial(name)}
                    userId={peer?.userId ?? mk.channelId} discriminator={peer?.discriminator} />}
            </button>}
            actions={onUnmark && <Button variant="ghost" size="icon" aria-label="Unmark" title="Unmark"
              data-testid={tid.inboxUnmark(mk.m.id)}
              className={cn(cardActionClassName, "text-muted-foreground hover:text-foreground")}
              onClick={() => onUnmark(mk.m.id)}>
              <Trash2 className="size-4" />
            </Button>}
          >
            <div data-slot="inbox-card-messages" className="min-w-0 px-2 sm:px-4">
              <InboxMessagePreview message={{ ...mk.m, grouped: false }} continuation={!mk.serverId} onOpen={open} />
            </div>
          </InboxCard>
        )
      })}
    </InboxScrollBody>
  )
}

export function InboxPopover({
  friendRequests = [],
  unreads,
  unreadDms,
  mentions,
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
  onOpenFriendRequests,
  onAcceptFriendRequest,
  onRejectFriendRequest,
  onRetryFriendRequest,
  onOpenChannel,
  onOpenThread,
  onOpenDm,
  onOpenMention,
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
  channelReadActions,
  surface = "desktop",
}: {
  friendRequests?: Array<ActionableFriendRequest<InboxFriendRequest>>
  unreads: UnreadServer[]
  unreadDms: UnreadDm[]
  mentions: Mention[]
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
  onOpenMention?: (m: Mention) => void
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
  channelReadActions?: ReadonlyMap<string, InboxChannelReadAction>
  surface?: "desktop" | "mobile" | "extension"
}) {
  const profilesByUserId = useCanonicalProfilesByUserId()
  const directory = useInboxCardDirectory()
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
      className={surface === "desktop" ? "flex h-112 flex-col" : "flex h-full min-h-0 flex-col"}
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
        <TabsTrigger value="marked">Marked</TabsTrigger>
      </TabsList>
      <TabsContent value="unreads" className="min-h-0 flex-1 pt-3">
        <UnreadsTab
          friendRequests={friendRequests}
          servers={unreads}
          dms={unreadDms}
          mentions={mentions}
          onOpenMention={onOpenMention}
          renderUnreadMessages={renderUnreadMessages}
          onMarkChannelRead={onMarkChannelRead}
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
      <TabsContent value="marked" className="min-h-0 flex-1 pt-3">
        <MarkedTab marked={marked} loading={markedLoading} error={markedError} retrying={markedRetrying} onRetry={onRetryMarked} onOpenMarked={onOpenMarked} onUnmark={onUnmark} directory={directory} getScrollOffset={getScrollOffset} onScrollOffsetChange={onScrollOffsetChange} />
      </TabsContent>
    </Tabs>
  )
}

function InboxRowsSkeleton() {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 rounded-md p-2">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-2/5 rounded" />
            <Skeleton className="h-3 w-3/4 rounded" />
            <Skeleton className="h-3 w-1/4 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

function InboxUnreadsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 2 }).map((_, gi) => (
        <div key={gi}>
          <div className="px-2 pb-1">
            <Skeleton className="h-3 w-24 rounded" />
          </div>
          {Array.from({ length: 3 }).map((_, ri) => (
            <div key={ri} className="flex items-center gap-2 rounded-md px-2 py-2">
              <Skeleton className="size-4 shrink-0 rounded" />
              <Skeleton className="h-3.5 flex-1 rounded" style={{ maxWidth: 140 + ((ri * 23) % 60) }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
