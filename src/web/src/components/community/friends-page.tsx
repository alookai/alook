"use client"

import { useState, useEffect, useRef } from "react"
import type React from "react"
import { Users, MessagesSquare, ChevronLeft, Check, X, AtSign, UserMinus, Ban, UserPlus } from "lucide-react"
import { apiFetch } from "@/lib/api/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import { EmptyState } from "./empty-state"
import type { Friend, PendingRequest, BlockedUser, OpenProfile } from "./_types"

function FriendSection({ title, count, emptyLabel, children }: {
  title: string
  count: number
  emptyLabel: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      {count === 0 ? <EmptyState icon={Users} label={emptyLabel} /> : <div className="flex flex-col gap-0.5">{children}</div>}
    </div>
  )
}

// Friends page (@me, no DM selected) — online / all / pending / blocked tabs.
export function FriendsPage({
  friends, pending, blocked, loading, onBack,
  onAccept, onReject, onCancelRequest, onUnblock, onSendRequest, onRemoveFriend, onBlock, onDm,
}: {
  friends: Friend[]
  pending: PendingRequest[]
  blocked: BlockedUser[]
  loading?: boolean
  onBack?: () => void
  onOpenProfile?: OpenProfile
  onAccept?: (id: string) => void
  onReject?: (id: string) => void
  onCancelRequest?: (id: string) => void
  onUnblock?: (id: string) => void
  onSendRequest?: (username: string) => void
  onRemoveFriend?: (id: string) => void
  onBlock?: (id: string) => void
  onDm?: (userId: string) => void
}) {
  const onlineFriends = friends.filter((f) => f.status === "online")
  const [addValue, setAddValue] = useState("")
  const [searchResults, setSearchResults] = useState<{ id: string; name: string; image: string | null }[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = addValue.trim()
    if (!q) { setSearchResults([]); return }
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await apiFetch<{ users: { id: string; name: string; image: string | null }[] }>(`/api/community/users/search?q=${encodeURIComponent(q)}`)
        setSearchResults(data.users)
      } catch { setSearchResults([]) }
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [addValue])

  const sendRequest = (name: string) => {
    onSendRequest?.(name)
    setAddValue("")
    setSearchResults([])
  }

  const friendList = (list: Friend[], title: string) => {
    if (loading && list.length === 0) {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title} — …</div>
          <FriendRowsSkeleton />
        </div>
      )
    }
    return (
    <FriendSection title={`${title} — ${list.length}`} count={list.length} emptyLabel="No friends yet. Search for users to add.">
      {list.map((f) => (
        <ContextMenu key={f.id}>
          <ContextMenuTrigger
            render={
              <button
                onClick={() => { if (f.userId) onDm?.(f.userId) }}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
              />
            }
          >
            <Avatar label={f.avatar} size={32} presence={f.status} dim={f.status === "offline"} />
            <div className="min-w-0 flex-1">
              <div className={`truncate text-sm font-medium ${f.status === "offline" ? "text-muted-foreground" : ""}`}>{f.name}</div>
              <div className="truncate text-xs text-muted-foreground">{f.sub}</div>
            </div>
            <span className="grid size-8 place-items-center rounded-full bg-secondary text-muted-foreground"><MessagesSquare className="size-4" /></span>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-44">
            <ContextMenuItem onClick={() => onRemoveFriend?.(f.id)}><UserMinus className="size-4" /> Remove friend</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onBlock?.(f.userId ?? f.id)} className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"><Ban className="size-4" /> Block</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </FriendSection>
    )
  }

  return (
    <Tabs defaultValue="online" className="min-h-0 flex-1">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3">
        {onBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
        )}
        <TabsList variant="line">
          <TabsTrigger value="online">Online</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="blocked">Blocked</TabsTrigger>
        </TabsList>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto thin-scrollbar p-5">
        {/* add-friend bar (shared across tabs) */}
        <div className="mb-5">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add a friend</div>
          <div className="relative mt-2">
            <div className="relative flex items-center gap-2">
              <div className="relative flex-1">
                <AtSign className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-11 pl-9"
                  placeholder="Search by username"
                  value={addValue}
                  onChange={(e) => setAddValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && addValue.trim()) sendRequest(addValue.trim()) }}
                />
              </div>
              <Button
                size="sm"
                className="h-11 px-4"
                disabled={!addValue.trim()}
                onClick={() => { if (addValue.trim()) sendRequest(addValue.trim()) }}
              >
                <UserPlus className="size-4" />
                Send request
              </Button>
            </div>
            {searchResults.length > 0 && (
              <div className="mt-1 rounded-md border border-border bg-popover p-1 shadow-(--e2)">
                {searchResults.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => sendRequest(u.name)}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-accent"
                  >
                    <Avatar label={u.image ?? u.name.charAt(0).toUpperCase()} size={28} />
                    <span className="flex-1 truncate text-sm font-medium">{u.name}</span>
                    <UserPlus className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <TabsContent value="online">{friendList(onlineFriends, "Online")}</TabsContent>
        <TabsContent value="all">{friendList(friends, "All friends")}</TabsContent>
        <TabsContent value="pending">
          {loading && pending.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pending — …</div>
              <FriendRowsSkeleton withActions />
            </div>
          ) : (
          <FriendSection title={`Pending — ${pending.length}`} count={pending.length} emptyLabel="No pending requests. When someone adds you, it'll show up here.">
            {pending.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-md px-2.5 py-2.5 hover:bg-accent">
                <Avatar label={p.avatar} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.kind === "incoming" ? "Incoming request" : "Outgoing request"}</div>
                </div>
                {p.kind === "incoming" ? (
                  <div className="flex gap-1.5">
                    <Button variant="secondary" size="icon-sm" onClick={() => onAccept?.(p.id)} className="rounded-full text-status-online" aria-label="Accept"><Check className="size-4" /></Button>
                    <Button variant="secondary" size="icon-sm" onClick={() => onReject?.(p.id)} className="rounded-full text-destructive" aria-label="Reject"><X className="size-4" /></Button>
                  </div>
                ) : (
                  <Button variant="secondary" size="icon-sm" onClick={() => onCancelRequest?.(p.id)} className="rounded-full" aria-label="Cancel"><X className="size-4" /></Button>
                )}
              </div>
            ))}
          </FriendSection>
          )}
        </TabsContent>
        <TabsContent value="blocked">
          {loading && blocked.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Blocked — …</div>
              <FriendRowsSkeleton withActions />
            </div>
          ) : (
          <FriendSection title={`Blocked — ${blocked.length}`} count={blocked.length} emptyLabel="You haven't blocked anyone.">
            {blocked.map((b) => (
              <div key={b.id} className="flex items-center gap-3 rounded-md px-2.5 py-2.5 hover:bg-accent">
                <Avatar label={b.avatar} size={32} dim />
                <div className="min-w-0 flex-1 truncate text-sm font-medium">{b.name}</div>
                <Button variant="secondary" size="sm" onClick={() => onUnblock?.(b.userId ?? b.id)}>Unblock</Button>
              </div>
            ))}
          </FriendSection>
          )}
        </TabsContent>
      </div>
    </Tabs>
  )
}

// Skeleton rows for the friends/pending/blocked tabs. `withActions` reserves
// the trailing action-button slot so pending/blocked rows don't reflow into
// the friend-row footprint and back.
function FriendRowsSkeleton({ withActions = false }: { withActions?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md px-2 py-2">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-2/5 rounded" />
            <Skeleton className="h-3 w-3/5 rounded" />
          </div>
          {withActions ? (
            <div className="flex gap-1.5">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <Skeleton className="size-8 shrink-0 rounded-full" />
            </div>
          ) : (
            <Skeleton className="size-8 shrink-0 rounded-full" />
          )}
        </div>
      ))}
    </div>
  )
}
