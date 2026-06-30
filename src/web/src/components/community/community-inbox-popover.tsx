import type React from "react"
import { AtSign, ChevronRight, Hash, Inbox, MessagesSquare, MoreHorizontal, Reply, Trash2 } from "lucide-react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Avatar } from "./avatar"
import { EmptyState } from "./empty-state"
import { formatRelativeTime } from "./format-time"
import type { ForYouEvent, ForYouKind, Mention, UnreadServer } from "./_types"

function KindIcon({ kind }: { kind: ForYouKind }) {
  const cls = "size-4 text-muted-foreground"
  if (kind === "mention") return <AtSign className={cls} />
  if (kind === "reply") return <Reply className={cls} />
  return <MessagesSquare className={cls} />
}

function kindLabel(e: ForYouEvent): React.ReactNode {
  if (e.kind === "mention") return <><span className="font-medium">{e.authorName}</span> mentioned you</>
  if (e.kind === "reply") return <><span className="font-medium">{e.authorName}</span> replied to you</>
  return <>New activity in thread</>
}

function ForYouTab({ events, onOpenEvent, onDismissEvent }: {
  events: ForYouEvent[]
  onOpenEvent?: (e: ForYouEvent) => void
  onDismissEvent?: (eventKey: string) => void
}) {
  return (
    <div className="h-full overflow-y-auto thin-scrollbar p-2">
      {events.length === 0 && <EmptyState icon={Inbox} label="Nothing for you right now" />}
      {events.map((e) => (
        <div key={e.eventKey} className="group flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-accent">
          <button onClick={() => onOpenEvent?.(e)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
            {e.kind === "thread" ? (
              <div className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
                <MessagesSquare className="size-4 text-muted-foreground" />
              </div>
            ) : (
              <Avatar label={e.authorAvatar || "?"} size={36} />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <KindIcon kind={e.kind} />
                <div className="truncate text-sm">{kindLabel(e)}</div>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                in <span className="font-medium">{e.serverName}</span> · #{e.channelName}
              </div>
              {e.preview && <div className="mt-0.5 truncate text-sm text-muted-foreground">{e.preview}</div>}
              <div className="mt-0.5 text-xs text-muted-foreground" suppressHydrationWarning>{formatRelativeTime(e.createdAt)}</div>
            </div>
          </button>
          {onDismissEvent && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<button className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100" aria-label="More" />}>
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4} className="w-36">
                <DropdownMenuItem onClick={() => onDismissEvent(e.eventKey)}>
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

function UnreadsTab({ servers, onOpenChannel }: {
  servers: UnreadServer[]
  onOpenChannel?: (serverId: string, channelId: string) => void
}) {
  return (
    <div className="h-full overflow-y-auto thin-scrollbar p-2">
      {servers.length === 0 && <EmptyState icon={Inbox} label="Caught up" />}
      {servers.map((s) => (
        <div key={s.serverId} className="mb-3">
          <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.serverName}</div>
          {s.channels.map((c) => (
            <button
              key={c.channelId}
              onClick={() => onOpenChannel?.(s.serverId, c.channelId)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
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

function MentionsTab({ mentions, onOpenMention, onDeleteMention }: {
  mentions: Mention[]
  onOpenMention?: (m: Mention) => void
  onDeleteMention?: (id: string) => void
}) {
  return (
    <div className="h-full overflow-y-auto thin-scrollbar p-2">
      {mentions.length === 0 && <EmptyState icon={Inbox} label="No mentions" />}
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
              <DropdownMenuTrigger render={<button className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100" aria-label="More" />}>
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
  forYou,
  unreads,
  mentions,
  onOpenEvent,
  onOpenChannel,
  onOpenMention,
  onDismissEvent,
  onDeleteMention,
  onMarkAllRead,
}: {
  forYou: ForYouEvent[]
  unreads: UnreadServer[]
  mentions: Mention[]
  onOpenEvent?: (e: ForYouEvent) => void
  onOpenChannel?: (serverId: string, channelId: string) => void
  onOpenMention?: (m: Mention) => void
  onDismissEvent?: (eventKey: string) => void
  onDeleteMention?: (id: string) => void
  onMarkAllRead?: () => void
}) {
  const hasAnything = forYou.length > 0 || unreads.length > 0 || mentions.length > 0
  return (
    <Tabs defaultValue="foryou" className="flex h-[28rem] flex-col">
      <div className="flex items-center gap-2 px-4 pt-4">
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
      <TabsList variant="line" className="mt-3 w-full border-b border-border px-2">
        <TabsTrigger value="foryou">
          <span className="inline-flex items-center gap-1.5">
            For You
            {forYou.length > 0 && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
        </TabsTrigger>
        <TabsTrigger value="unreads">
          <span className="inline-flex items-center gap-1.5">
            Unreads
            {unreads.length > 0 && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
        </TabsTrigger>
        <TabsTrigger value="mentions">
          <span className="inline-flex items-center gap-1.5">
            Mentions
            {mentions.length > 0 && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="foryou" className="min-h-0 flex-1">
        <ForYouTab events={forYou} onOpenEvent={onOpenEvent} onDismissEvent={onDismissEvent} />
      </TabsContent>
      <TabsContent value="unreads" className="min-h-0 flex-1">
        <UnreadsTab servers={unreads} onOpenChannel={onOpenChannel} />
      </TabsContent>
      <TabsContent value="mentions" className="min-h-0 flex-1">
        <MentionsTab mentions={mentions} onOpenMention={onOpenMention} onDeleteMention={onDeleteMention} />
      </TabsContent>
    </Tabs>
  )
}
