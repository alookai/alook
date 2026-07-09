import { ChevronRight, Hash, Inbox, MoreHorizontal, Trash2 } from "lucide-react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import { EmptyState } from "./empty-state"
import type { Mention, UnreadDm, UnreadServer } from "./_types"

function UnreadsTab({ servers, dms, loading, onOpenChannel, onOpenDm }: {
  servers: UnreadServer[]
  dms: UnreadDm[]
  loading?: boolean
  onOpenChannel?: (serverId: string, channelId: string) => void
  onOpenDm?: (dmId: string) => void
}) {
  const nothingUnread = servers.length === 0 && dms.length === 0
  return (
    <div className="h-full overflow-y-auto thin-scrollbar p-3">
      {loading && nothingUnread && <InboxUnreadsSkeleton />}
      {!loading && nothingUnread && <EmptyState icon={Inbox} label="Caught up" />}
      {dms.length > 0 && (
        <div className="mb-3">
          <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Direct Messages</div>
          {dms.map((d) => (
            <button
              key={d.dmConversationId}
              onClick={() => onOpenDm?.(d.dmConversationId)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
            >
              <Avatar label={d.otherUserAvatar} size={24} />
              <span className="min-w-0 flex-1 truncate">{d.otherUserName}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
      {servers.map((s) => (
        <div key={s.serverId} className="mb-3">
          <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.serverName}</div>
          {s.channels.map((c) => (
            <button
              key={c.channelId}
              onClick={() => onOpenChannel?.(s.serverId, c.channelId)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
            >
              <Hash className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{c.channelName}</span>
              {c.mentionCount > 0 && (
                <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground">{c.mentionCount}</span>
              )}
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

function MentionsTab({ mentions, loading, onOpenMention, onDeleteMention }: {
  mentions: Mention[]
  loading?: boolean
  onOpenMention?: (m: Mention) => void
  onDeleteMention?: (id: string) => void
}) {
  return (
    <div className="h-full overflow-y-auto thin-scrollbar p-3">
      {loading && mentions.length === 0 && <InboxRowsSkeleton />}
      {!loading && mentions.length === 0 && <EmptyState icon={Inbox} label="No mentions" />}
      {mentions.map((mn) => (
        <div key={mn.id} className="group flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-accent">
          <button onClick={() => onOpenMention?.(mn)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
            <Avatar label={mn.m.authorAvatar ?? "?"} size={36} />
            <div className="min-w-0 flex-1">
              <div className="text-sm">
                <span className="font-medium">{mn.m.authorName}</span>{" "}
                <span className="text-xs text-muted-foreground">in {mn.server} · #{mn.channel}</span>
              </div>
              <div className="truncate text-sm text-muted-foreground">{mn.m.content}</div>
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
      ))}
    </div>
  )
}

export function InboxPopover({
  unreads,
  unreadDms,
  mentions,
  loading,
  onOpenChannel,
  onOpenDm,
  onOpenMention,
  onDeleteMention,
  onMarkAllRead,
}: {
  unreads: UnreadServer[]
  unreadDms: UnreadDm[]
  mentions: Mention[]
  loading?: boolean
  onOpenChannel?: (serverId: string, channelId: string) => void
  onOpenDm?: (dmId: string) => void
  onOpenMention?: (m: Mention) => void
  onDeleteMention?: (id: string) => void
  onMarkAllRead?: () => void
}) {
  const hasUnreads = unreads.length > 0 || unreadDms.length > 0
  const hasAnything = hasUnreads || mentions.length > 0
  return (
    <Tabs defaultValue="unreads" className="flex h-112 flex-col">
      <div className="flex items-center gap-2 px-3 pt-4">
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
      <TabsList variant="line" className="mt-3 w-full border-b border-border px-3">
        <TabsTrigger value="unreads">
          <span className="inline-flex items-center gap-2">
            Unreads
            {hasUnreads && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
        </TabsTrigger>
        <TabsTrigger value="mentions">
          <span className="inline-flex items-center gap-2">
            Mentions
            {mentions.length > 0 && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="unreads" className="min-h-0 flex-1">
        <UnreadsTab servers={unreads} dms={unreadDms} loading={loading} onOpenChannel={onOpenChannel} onOpenDm={onOpenDm} />
      </TabsContent>
      <TabsContent value="mentions" className="min-h-0 flex-1">
        <MentionsTab mentions={mentions} loading={loading} onOpenMention={onOpenMention} onDeleteMention={onDeleteMention} />
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
