import { Inbox } from "lucide-react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Avatar } from "./avatar"
import { EmptyState } from "./empty-state"
import { formatRelativeTime } from "./format-time"
import type { InboxRow, Mention } from "./_types"

// Inbox popover content (rendered inside a shadcn Popover from the top bar).
// Named community-inbox-popover to stay distinct from the main app's inbox-popover.
function InboxFeedRows({ feed, unreadOnly, onOpenItem }: { feed: InboxRow[]; unreadOnly?: boolean; onOpenItem?: (id: string) => void }) {
  const filtered = feed.filter((f) => !unreadOnly || f.unread)
  return (
    <div className="max-h-90 overflow-y-auto thin-scrollbar p-1.5">
      {filtered.length === 0 && (
        <EmptyState icon={Inbox} label={unreadOnly ? "All caught up." : "No activity yet."} />
      )}
      {filtered.map((f) => (
        <button key={f.id} onClick={() => onOpenItem?.(f.id)} className="group flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-accent">
          <div className="relative grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {f.initial}
            {f.unread && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-popover bg-primary" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">You have new messages in <span className="font-semibold">{f.server}</span>.</div>
            <div className="text-xs text-muted-foreground" suppressHydrationWarning>{formatRelativeTime(f.lastActivityAt)}</div>
          </div>
          {f.unread && <span className="size-2 shrink-0 rounded-full bg-primary" />}
        </button>
      ))}
    </div>
  )
}

export function InboxPopover({ feed, mentions, onOpenItem, onMarkAllRead }: { feed: InboxRow[]; mentions: Mention[]; onOpenItem?: (id: string) => void; onMarkAllRead?: () => void }) {
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
      <TabsContent value="foryou"><InboxFeedRows feed={feed} onOpenItem={onOpenItem} /></TabsContent>
      <TabsContent value="unreads"><InboxFeedRows feed={feed} unreadOnly onOpenItem={onOpenItem} /></TabsContent>
      <TabsContent value="mentions">
        <div className="max-h-90 overflow-y-auto thin-scrollbar p-1.5">
          {mentions.length === 0 ? (
            <EmptyState icon={Inbox} label="No mentions yet." />
          ) : (
            mentions.map((mn) => (
              <button key={mn.id} onClick={() => onOpenItem?.(mn.id)} className="flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-accent">
                <Avatar label={mn.m.authorAvatar ?? "?"} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    <span className="font-medium">{mn.m.authorName}</span>{" "}
                    <span className="text-xs text-muted-foreground">in {mn.server} · #{mn.channel}</span>
                  </div>
                  <div className="truncate text-sm text-muted-foreground">{mn.m.content}</div>
                </div>
              </button>
            ))
          )}
        </div>
      </TabsContent>
    </Tabs>
  )
}
