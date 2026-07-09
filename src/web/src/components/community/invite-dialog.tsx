"use client"

import { useEffect, useMemo, useState } from "react"
import { Search } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import { useInvitableFriends } from "@/hooks/community/use-invitable-friends"
import {
  useResolveOrCreateInvite,
  useCreateOrGetDm,
  useSendDmMessage,
} from "@/hooks/community/mutations"
import { useCurrentUser } from "@/contexts/community/current-user"
import type { Friend } from "./_types"

const INVITE_ORIGIN =
  typeof window !== "undefined" ? window.location.origin : ""

function inviteUrl(token: string) {
  return `${INVITE_ORIGIN}/community/invite/${token}`
}

/**
 * Invite dialog: friends list at the top (each with an "Invite"
 * button that sends the invite URL as a DM), plus a copyable link at the
 * bottom. Modal-shaped (not floating) so the vertical stack of friends can
 * comfortably scroll without fighting a popover's anchor boundaries.
 *
 * The invite link is resolved lazily on open: reuse an existing valid invite
 * if one exists in cache, otherwise POST a new one. This bounds the total
 * active-invite count regardless of how often the dialog gets opened.
 */
export function InviteDialog({
  open,
  onOpenChange,
  serverId,
  serverName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverId: string
  serverName: string
}) {
  const currentUser = useCurrentUser()
  // Only friends who are NOT already members of `serverId` — server-side
  // filter so a stale local members cache can't leak already-joined rows.
  const { friends, isLoading: friendsLoading } = useInvitableFriends(serverId, open)
  const resolveOrCreate = useResolveOrCreateInvite(serverId)
  const createOrGetDm = useCreateOrGetDm()
  const sendDm = useSendDmMessage()

  const [token, setToken] = useState<string | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [invitedUserIds, setInvitedUserIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")

  // Resolve on open. Only depends on `open` + `token` — resolveOrCreate is a
  // hook that captures a fresh mutation object each render, so including it in
  // deps would loop. We read its latest identity via a closure at call time
  // instead, which is safe because we only need the "current" version.
  useEffect(() => {
    if (!open || token) return
    let cancelled = false
    setResolveError(null)
    resolveOrCreate(currentUser.id, currentUser.name)
      .then((iv) => {
        if (!cancelled) setToken(iv.token)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : "Couldn't create an invite"
        setResolveError(msg)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token])

  // Reset local per-open state when the dialog closes — wrapping the caller's
  // onOpenChange keeps this in the click handler path (not an effect), so
  // there's no dependency-array churn like the previous useEffect implementation.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setInvitedUserIds(new Set())
      setQuery("")
    }
    onOpenChange(next)
  }

  const eligibleFriends = useMemo<Friend[]>(() => {
    const q = query.trim().toLowerCase()
    return friends.filter((f) => {
      if (!q) return true
      return (
        f.name.toLowerCase().includes(q) ||
        (f.sub ?? "").toLowerCase().includes(q)
      )
    })
  }, [friends, query])

  const inviteFriend = async (friend: Friend) => {
    if (!token || !friend.userId) return
    try {
      const { conversation } = await createOrGetDm.mutateAsync({ userId: friend.userId })
      await sendDm.mutateAsync({
        dmId: conversation.id,
        content: inviteUrl(token),
        author: {
          id: currentUser.id,
          name: currentUser.name,
          avatar: currentUser.avatar,
        },
      })
      setInvitedUserIds((prev) => {
        const next = new Set(prev)
        next.add(friend.userId!)
        return next
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't send invite"
      toast(msg)
    }
  }

  const copyLink = async () => {
    if (!token) return
    try {
      await navigator.clipboard.writeText(inviteUrl(token))
      toast("Invite link copied")
    } catch {
      toast("Couldn't copy — copy manually")
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-full flex-col gap-0 p-0 sm:max-w-md">
        <header className="border-b border-border px-4 py-3">
          <h2 className="truncate text-sm font-semibold">Invite friends to {serverName}</h2>
        </header>

        <div className="px-4 pt-3">
          <label className="relative block">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for friends"
              className="pl-9"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar px-2 py-2">
          {friendsLoading && friends.length === 0 ? (
            <div className="space-y-2 px-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <Skeleton className="h-3 w-32 rounded" />
                </div>
              ))}
            </div>
          ) : eligibleFriends.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {friends.length === 0
                ? "No friends to invite — everyone you know is already here."
                : "No matches."}
            </p>
          ) : (
            eligibleFriends.map((f) => {
              const invited = f.userId ? invitedUserIds.has(f.userId) : false
              return (
                <div
                  key={f.id}
                  className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40"
                >
                  <Avatar label={f.avatar || f.name} size={32} presence={f.status} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{f.name}</div>
                    {f.sub && (
                      <div className="truncate text-xs text-muted-foreground">{f.sub}</div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant={invited ? "secondary" : "default"}
                    disabled={!token || invited || !f.userId}
                    onClick={() => inviteFriend(f)}
                  >
                    {invited ? "Invited" : "Invite"}
                  </Button>
                </div>
              )
            })
          )}
        </div>

        <footer className="border-t border-border px-4 py-3">
          <div className="text-xs font-medium text-muted-foreground">
            Or, send a server invite link to a friend
          </div>
          {resolveError ? (
            <p className="mt-2 text-xs text-destructive">{resolveError}</p>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <Input
                readOnly
                value={token ? inviteUrl(token) : ""}
                placeholder={token ? "" : "Loading…"}
                className="font-mono text-xs"
              />
              <Button size="sm" onClick={copyLink} disabled={!token}>
                Copy
              </Button>
            </div>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
