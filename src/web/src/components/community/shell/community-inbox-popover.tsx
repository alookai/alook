import { Bookmark, ChevronRight, Inbox, MoreHorizontal, Trash2 } from "lucide-react"
import { stripInlineMarkup } from "@alook/shared"
import { EntityIcon } from "../entity-icon"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "../avatar"
import { ChannelIcon } from "../channels/channel-icon"
import { EmptyState } from "../empty-state"
import { formatRelativeTime } from "@/lib/community/format-time"
import type { Marked, Mention, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import {
  inboxChannelRowTarget,
  inboxDmRowTarget,
  inboxMentionRowTarget,
  inboxThreadRowTarget,
  type InboxRowTarget,
} from "@/hooks/community/inbox-read-reservation"
import { tid } from "@/lib/community/testids"
import type { CommunityProfile } from "@/lib/community/models/people"
import { useProfilesByUserId } from "@/stores/community/ws"
import { readCommunityProfile } from "@/lib/community/profile-read"
import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react"

type UnreadChannel = UnreadServer["channels"][number]
type UnreadChild = UnreadChannel["children"][number]
export type InboxTab = "unreads" | "mentions" | "marked"

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
      className="h-full overflow-y-auto thin-scrollbar p-3"
      onScroll={onScroll}
      onWheel={() => { transientScrollRef.current = true }}
      onKeyDown={onKeyDown}
      onPointerDown={() => { pointerScrollRef.current = true }}
      onPointerUp={() => { pointerScrollRef.current = false }}
      onPointerCancel={() => { pointerScrollRef.current = false }}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  )
}

function MentionBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground">
      {count}
    </span>
  )
}

function UnreadsTab({ servers, dms, loading, onOpenChannel, onOpenThread, onOpenDm, isProjected, profilesByUserId, getScrollOffset, onScrollOffsetChange }: {
  servers: UnreadServer[]
  dms: UnreadDm[]
  loading?: boolean
  onOpenChannel?: (
    server: UnreadServer,
    channel: UnreadChannel,
    directUnreadVisible: boolean,
  ) => void
  onOpenThread: (server: UnreadServer, parent: UnreadChannel, child: UnreadChild) => void
  onOpenDm?: (dm: UnreadDm) => void
  isProjected: (target: InboxRowTarget | null) => boolean
  profilesByUserId: ReadonlyMap<string, CommunityProfile>
  getScrollOffset?: (tab: InboxTab) => number
  onScrollOffsetChange?: (tab: InboxTab, scrollTop: number) => void
}) {
  const visibleDms = dms.filter((dm) => !isProjected(inboxDmRowTarget(dm)))
  const visibleServers = servers.map((server) => ({
    server,
    channels: server.channels.map((channel) => {
      const directTarget = inboxChannelRowTarget(server, channel)
      return {
        channel,
        directVisible: directTarget !== null && !isProjected(directTarget),
        children: channel.children.filter((child) => (
          !isProjected(inboxThreadRowTarget(server, channel, child))
        )),
      }
    }).filter((group) => group.directVisible || group.children.length > 0),
  })).filter((group) => group.channels.length > 0)
  const nothingUnread = visibleServers.length === 0 && visibleDms.length === 0
  return (
    <InboxScrollBody tab="unreads" getScrollOffset={getScrollOffset} onScrollOffsetChange={onScrollOffsetChange}>
      {loading && nothingUnread && <InboxUnreadsSkeleton />}
      {!loading && nothingUnread && <EmptyState icon={Inbox} label="Caught up" />}
      {visibleDms.length > 0 && (
        <div className="mb-3">
          <div className="px-2 pb-1 text-xs font-semibold text-muted-foreground">Direct Messages</div>
          {visibleDms.map((d) => {
            const profile = readCommunityProfile(
              profilesByUserId.get(d.otherUserId),
              d.otherUserId,
            )
            return (
            <button
              key={d.channelId}
              data-testid={tid.inboxUnreadDm(d.channelId)}
              onClick={() => onOpenDm?.(d)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
            >
              <Avatar label={profile.avatar} seed={d.otherUserId} size={24} />
              <span className="min-w-0 flex-1 truncate">{profile.name}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
            )
          })}
        </div>
      )}
      {visibleServers.map(({ server, channels }) => (
        <div key={server.serverId} className="mb-3">
          <div className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{server.serverName}</div>
          {channels.map(({ channel, directVisible, children }) => (
            <div key={channel.channelId}>
              <button
                data-testid={tid.inboxUnreadChannel(channel.channelId)}
                onClick={() => onOpenChannel?.(server, channel, directVisible)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
              >
                <EntityIcon kind={channel.type} className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{channel.channelName}</span>
                {directVisible && <MentionBadge count={channel.mentionCount} />}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
              {children.map((child) => (
                <button
                  key={child.channelId}
                  data-testid={tid.inboxUnreadChild(child.channelId)}
                  onClick={() => onOpenThread(server, channel, child)}
                  className="flex w-full items-center gap-2 rounded-md py-1.5 pl-8 pr-2 text-left text-sm hover:bg-accent"
                >
                  <EntityIcon kind={child.type} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{child.channelName}</span>
                  <MentionBadge count={child.mentionCount} />
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          ))}
        </div>
      ))}
    </InboxScrollBody>
  )
}

function MentionsTab({ mentions, loading, onOpenMention, onDeleteMention, isProjected, profilesByUserId, getScrollOffset, onScrollOffsetChange }: {
  mentions: Mention[]
  loading?: boolean
  onOpenMention?: (m: Mention) => void
  onDeleteMention?: (id: string) => void
  isProjected: (target: InboxRowTarget | null) => boolean
  profilesByUserId: ReadonlyMap<string, CommunityProfile>
  getScrollOffset?: (tab: InboxTab) => number
  onScrollOffsetChange?: (tab: InboxTab, scrollTop: number) => void
}) {
  const visibleMentions = mentions.filter((mention) => (
    !isProjected(inboxMentionRowTarget(mention))
  ))
  return (
    <InboxScrollBody tab="mentions" getScrollOffset={getScrollOffset} onScrollOffsetChange={onScrollOffsetChange}>
      {loading && visibleMentions.length === 0 && <InboxRowsSkeleton />}
      {!loading && visibleMentions.length === 0 && <EmptyState icon={Inbox} label="No mentions" />}
      {visibleMentions.map((mn) => {
        const author = readCommunityProfile(
          mn.m.authorId ? profilesByUserId.get(mn.m.authorId) : undefined,
          mn.m.authorId ?? "",
        )
        return (
        <div key={mn.id} className="group flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-accent">
          <button onClick={() => onOpenMention?.(mn)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
            <Avatar label={author.avatar} seed={mn.m.authorId} size={36} />
            <div className="min-w-0 flex-1">
              <div className="text-sm">
                <span className="font-medium">{author.name}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  {mn.kind === "reply" ? "replied to you" : "mentioned you"} in {mn.server} · <ChannelIcon className="inline h-[1em] w-auto align-[-0.1em]" />{mn.channel}
                </span>
              </div>
              <div className="truncate text-sm text-muted-foreground">{stripInlineMarkup(mn.m.content ?? "")}</div>
            </div>
          </button>
          {onDeleteMention && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<button className="mt-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100" aria-label="More" />}>
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4} className="w-36">
                <DropdownMenuItem onClick={() => onDeleteMention(mn.id)}>
                  <Trash2 className="size-4" />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        )
      })}
    </InboxScrollBody>
  )
}

function MarkedTab({ marked, loading, onOpenMarked, onUnmark, profilesByUserId, getScrollOffset, onScrollOffsetChange }: {
  marked: Marked[]
  loading?: boolean
  onOpenMarked?: (m: Marked) => void
  onUnmark?: (messageId: string) => void
  profilesByUserId: ReadonlyMap<string, CommunityProfile>
  getScrollOffset?: (tab: InboxTab) => number
  onScrollOffsetChange?: (tab: InboxTab, scrollTop: number) => void
}) {
  return (
    <InboxScrollBody tab="marked" getScrollOffset={getScrollOffset} onScrollOffsetChange={onScrollOffsetChange}>
      {loading && marked.length === 0 && <InboxRowsSkeleton />}
      {!loading && marked.length === 0 && <EmptyState icon={Bookmark} label="No marked messages" />}
      {marked.map((mk) => {
        const author = readCommunityProfile(
          mk.m.authorId ? profilesByUserId.get(mk.m.authorId) : undefined,
          mk.m.authorId ?? "",
        )
        return (
        <div key={mk.id} className="group flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-accent">
          <button onClick={() => onOpenMarked?.(mk)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
            <Avatar label={author.avatar} seed={mk.m.authorId} size={36} />
            <div className="min-w-0 flex-1">
              <div className="text-sm">
                <span className="font-medium">{author.name}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  in{" "}
                  {mk.serverId
                    ? <>{mk.server} · <ChannelIcon className="inline h-[1em] w-auto align-[-0.1em]" />{mk.channel}</>
                    : "DM"}
                  {mk.m.createdAt && <> · {formatRelativeTime(mk.m.createdAt)}</>}
                </span>
              </div>
              <div className="truncate text-sm text-muted-foreground">{stripInlineMarkup(mk.m.content ?? "")}</div>
            </div>
          </button>
          {onUnmark && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<button className="mt-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100" aria-label="More" />}>
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4} className="w-36">
                <DropdownMenuItem onClick={() => onUnmark(mk.m.id)}>
                  <Trash2 className="size-4" />
                  Unmark
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        )
      })}
    </InboxScrollBody>
  )
}

export function InboxPopover({
  unreads,
  unreadDms,
  mentions,
  marked,
  markedLoading,
  loading,
  hasProjectedUnreads,
  hasProjectedMentions,
  onOpenChannel,
  onOpenThread,
  onOpenForumThread,
  onOpenDm,
  onOpenMention,
  onOpenMarked,
  onDeleteMention,
  onUnmark,
  onMarkedTabSelected,
  onMarkAllRead,
  isProjected = () => false,
  activeTab,
  onActiveTabChange,
  getScrollOffset,
  onScrollOffsetChange,
  surface = "desktop",
}: {
  unreads: UnreadServer[]
  unreadDms: UnreadDm[]
  mentions: Mention[]
  marked: Marked[]
  markedLoading?: boolean
  loading?: boolean
  hasProjectedUnreads?: boolean
  hasProjectedMentions?: boolean
  onOpenChannel?: (
    server: UnreadServer,
    channel: UnreadChannel,
    directUnreadVisible: boolean,
  ) => void
  onOpenThread?: (server: UnreadServer, parent: UnreadChannel, child: UnreadChild) => void
  /** Compatibility for non-community showcase fixtures; product wiring uses onOpenThread. */
  onOpenForumThread?: (
    server: UnreadServer,
    parent: UnreadChannel,
    child: UnreadChild,
  ) => void
  onOpenDm?: (dm: UnreadDm) => void
  onOpenMention?: (m: Mention) => void
  onOpenMarked?: (m: Marked) => void
  onDeleteMention?: (id: string) => void
  onUnmark?: (messageId: string) => void
  // Fired when the Marked tab becomes active — the shell uses this to enable
  // the (lazy) marked-feed query only once the viewer actually opens the tab.
  onMarkedTabSelected?: () => void
  onMarkAllRead?: () => void
  isProjected?: (target: InboxRowTarget | null) => boolean
  activeTab?: InboxTab
  onActiveTabChange?: (tab: InboxTab) => void
  getScrollOffset?: (tab: InboxTab) => number
  onScrollOffsetChange?: (tab: InboxTab, scrollTop: number) => void
  surface?: "desktop" | "mobile"
}) {
  const profilesByUserId = useProfilesByUserId()
  const hasUnreads = hasProjectedUnreads ?? (unreads.length > 0 || unreadDms.length > 0)
  const hasMentions = hasProjectedMentions ?? mentions.length > 0
  const hasAnything = hasUnreads || hasMentions
  return (
    <Tabs
      defaultValue="unreads"
      value={activeTab}
      onValueChange={(value) => {
        const tab = value as InboxTab
        onActiveTabChange?.(tab)
        if (tab === "marked") onMarkedTabSelected?.()
      }}
      className={surface === "mobile" ? "flex h-full min-h-0 flex-col" : "flex h-112 flex-col"}
    >
      <div className={`flex items-center gap-2 px-3 pt-4 ${surface === "mobile" ? "pr-14" : ""}`}>
        <Inbox className="size-5" />
        <h2 className="flex-1 text-lg font-semibold">Inbox</h2>
        {onMarkAllRead && (
          <button
            onClick={onMarkAllRead}
            disabled={!hasAnything}
            className="text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
          >
            Mark all read
          </button>
        )}
      </div>
      <TabsList data-testid={tid.inboxTabList} variant="line" className="mt-3 w-full border-b border-border px-3">
        <TabsTrigger value="unreads">
          <span className="inline-flex items-center gap-2">
            Unreads
            {hasUnreads && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
        </TabsTrigger>
        <TabsTrigger value="mentions">
          <span className="inline-flex items-center gap-2">
            Mentions
            {hasMentions && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
        </TabsTrigger>
        <TabsTrigger value="marked">Marked</TabsTrigger>
      </TabsList>
      <TabsContent value="unreads" className="min-h-0 flex-1">
        <UnreadsTab
          servers={unreads}
          dms={unreadDms}
          loading={loading}
          onOpenChannel={onOpenChannel}
          onOpenThread={onOpenThread ?? onOpenForumThread ?? (() => {})}
          onOpenDm={onOpenDm}
          isProjected={isProjected}
          profilesByUserId={profilesByUserId}
          getScrollOffset={getScrollOffset}
          onScrollOffsetChange={onScrollOffsetChange}
        />
      </TabsContent>
      <TabsContent value="mentions" className="min-h-0 flex-1">
        <MentionsTab mentions={mentions} loading={loading} onOpenMention={onOpenMention} onDeleteMention={onDeleteMention} isProjected={isProjected} profilesByUserId={profilesByUserId} getScrollOffset={getScrollOffset} onScrollOffsetChange={onScrollOffsetChange} />
      </TabsContent>
      <TabsContent value="marked" className="min-h-0 flex-1">
        <MarkedTab marked={marked} loading={markedLoading} onOpenMarked={onOpenMarked} onUnmark={onUnmark} profilesByUserId={profilesByUserId} getScrollOffset={getScrollOffset} onScrollOffsetChange={onScrollOffsetChange} />
      </TabsContent>
    </Tabs>
  )
}

// Skeleton rows for Mentions — avatar + two text lines per item. Reserves
// the same gap as <MentionsTab> rows so the popover doesn't reflow when
// data lands.
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

// Unreads tab groups channels under server headers; mirror that shape.
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
