import { Inbox, MoreHorizontal, Trash2 } from "lucide-react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Avatar } from "./avatar"
import { EmptyState } from "./empty-state"
import { formatRelativeTime } from "./format-time"
import type { InboxRow, Mention } from "./_types"

function InboxFeedRows({ feed, unreadOnly, onOpenItem, onDismissItem }: { feed: InboxRow[]; unreadOnly?: boolean; onOpenItem?: (id: string) => void; onDismissItem?: (id: string) => void }) {
  const filtered = feed.filter((f) => !unreadOnly || f.unread)
  return (
    <div className="max-h-90 overflow-y-auto thin-scrollbar p-1.5">
      {filtered.length === 0 && (
        <EmptyState icon={Inbox} label={unreadOnly ? "All caught up." : "No activity yet."} />
      )}
      {filtered.map((f) => (
        <div key={f.id} className="group flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-accent">
          <button onClick={() => onOpenItem?.(f.id)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
            <div className="relative grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
              {f.initial}
              {f.unread && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-popover bg-primary" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">You have new messages in <span className="font-semibold">{f.server}</span>.</div>
              <div className="text-xs text-muted-foreground" suppressHydrationWarning>{formatRelativeTime(f.lastActivityAt)}</div>
            </div>
          </button>
          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
            {f.unread && <span className="size-2 rounded-full bg-primary" />}
            {onDismissItem && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<button className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100" aria-label="More" />}>
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4} className="w-36">
                  <DropdownMenuItem onClick={() => onDismissItem(f.id)}>
                    <Trash2 className="size-4" />
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

export function InboxPopover({ feed, mentions, onOpenItem, onOpenMention, onMarkAllRead, onDismissItem, onDeleteMention }: {
  feed: InboxRow[]
  mentions: Mention[]
  onOpenItem?: (id: string) => void
  onOpenMention?: (mention: Mention) => void
  onMarkAllRead?: () => void
  onDismissItem?: (id: string) => void
  onDeleteMention?: (id: string) => void
}) {
  return (
    <Tabs defaultValue="foryou">
      <div className="flex items-center gap-2 px-4 pt-3">
        <Inbox className="size-5" />
        <h2 className="flex-1 text-lg font-semibold">Inbox</h2>
        {onMarkAllRead && (
          <button onClick={onMarkAllRead} className="text-xs text-primary hover:underline">Mark all read</button>
        )}
      </div>
      <TabsList variant="line" className="mt-2 w-full border-b border-border px-2">
        <TabsTrigger value="foryou">For You</TabsTrigger>
        <TabsTrigger value="unreads">Unreads</TabsTrigger>
        <TabsTrigger value="mentions">Mentions</TabsTrigger>
      </TabsList>
      <TabsContent value="foryou"><InboxFeedRows feed={feed} onOpenItem={onOpenItem} onDismissItem={onDismissItem} /></TabsContent>
      <TabsContent value="unreads"><InboxFeedRows feed={feed} unreadOnly onOpenItem={onOpenItem} onDismissItem={onDismissItem} /></TabsContent>
      <TabsContent value="mentions">
        <div className="max-h-90 overflow-y-auto thin-scrollbar p-1.5">
          {mentions.length === 0 ? (
            <EmptyState icon={Inbox} label="No mentions yet." />
          ) : (
            mentions.map((mn) => (
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
            ))
          )}
        </div>
      </TabsContent>
    </Tabs>
  )
}
