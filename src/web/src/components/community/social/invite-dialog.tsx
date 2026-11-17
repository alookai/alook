"use client"

import { createStore, useSelector } from "@tanstack/react-store"
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"
import { Link2, Loader2, Search } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Avatar } from "../avatar"
import { PeoplePickerBody, PeoplePickerHeader, PeoplePickerRowsSkeleton, resolvePeoplePickerViewState } from "../people-picker"
import { hasStatus } from "./status-presets"
import { useInvitableFriends } from "@/hooks/community/use-invitable-friends"
import { useResolveOrCreateInvite, useCreateOrGetDm } from "@/hooks/community/mutations"
import { useFriendsPresence } from "@/hooks/community/use-friends"
import { useDmMessageSender, type DmSendReceipt } from "@/hooks/community/use-dm-message-sender"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { useInvites } from "@/hooks/community/use-server-panels"
import { isAbortError } from "@/lib/errors"
import type { Friend } from "@/lib/community/models/people"
import { captureProductAnalytics } from "@/lib/product-analytics"

const INVITE_ORIGIN =
  typeof window !== "undefined" ? window.location.origin : ""

function inviteUrl(token: string) {
  return `${INVITE_ORIGIN}/c/invite/${token}`
}

export function InviteFriendRow({
  friend,
  tokenReady,
  inviting,
  invited,
  onInvite,
}: {
  friend: Friend
  tokenReady: boolean
  inviting: boolean
  invited: boolean
  onInvite: (friend: Friend) => void
}) {
  return (
    <div
      data-slot="people-picker-row"
      className="flex items-center gap-3.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-accent/40"
    >
      <Avatar
        label={friend.avatar || friend.name}
        seed={friend.userId}
        size={38}
        presence={friend.status}
        ringColor="var(--tn-sticker-face, var(--popover))"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">{friend.name}</span>
          {friend.discriminator ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              #{friend.discriminator}
            </span>
          ) : null}
        </div>
        {hasStatus(friend.statusEmoji, friend.statusText) ? (
          <div className="truncate text-xs text-muted-foreground">
            {friend.statusEmoji} {friend.statusText}
          </div>
        ) : (
          <div className="truncate text-xs capitalize text-muted-foreground">
            {friend.status}
          </div>
        )}
      </div>
      <Button
        size="sm"
        variant={invited ? "secondary" : "default"}
        disabled={!tokenReady || inviting || invited || !friend.userId}
        onClick={() => onInvite(friend)}
      >
        {inviting ? (
          <Loader2 aria-label="Sending invite" className="size-4 animate-spin" />
        ) : invited ? (
          "Invited"
        ) : (
          "Invite"
        )}
      </Button>
    </div>
  )
}

export async function awaitCommittedInvite(
  receipt: DmSendReceipt,
  onCommitted: () => void = () => { void captureProductAnalytics({ event: "human_invitation_sent" }) },
) {
  if (!receipt.accepted) throw new Error("Couldn't send invite")
  const committed = await receipt.committed
  if (!committed.ok) throw committed.error
  onCommitted()
}

export async function copyInviteLink(
  url: string,
  writeText: (value: string) => Promise<void>,
  onCopied: () => void = () => { void captureProductAnalytics({ event: "human_invitation_copied" }) },
) {
  await writeText(url)
  onCopied()
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
  const client = useQueryClient()
  const view = useCommunityViewSource("server-invite:" + serverId, open)
  const ui = useMemo(() => ({ scope: [serverId, currentUser.id, open], store: createStore({ query: "", invitedUserIds: new Set<string>() }) }), [serverId, currentUser.id, open]).store
  const query = useSelector(ui, (state) => state.query)
  const invitedUserIds = useSelector(ui, (state) => state.invitedUserIds)
  const setQuery = (query: string) => ui.setState((state) => ({ ...state, query }))
  useFriendsPresence(open)
  const friendsQuery = useInvitableFriends(serverId, open)
  const invitesQuery = useInvites(serverId, open)
  const { friends } = friendsQuery
  const resolver = useResolveOrCreateInvite(serverId)
  const createOrGetDm = useCreateOrGetDm()
  const { accept: acceptDmMessage } = useDmMessageSender()
  const currentResolution = resolver.variables?.assert.signal === view.signal
  const selectedCode = currentResolution ? resolver.data?.token : undefined
  const token = invitesQuery.invites.find((row) => row.code === selectedCode)?.code
  const resolveError = currentResolution && resolver.error && !isAbortError(resolver.error) ? resolver.error.message : null
  const resolveInvite = resolver.mutate
  useEffect(() => {
    if (!open || currentResolution) return
    const assert = view.tryCapture()
    if (!assert) return
    resolveInvite({ currentUserId: currentUser.id, assert })
  }, [open, currentResolution, view, currentUser.id, resolveInvite])

  type SendIntent = { userId: string; token: string; author: { id: string; name: string; avatar: string }; assert: ReturnType<typeof view.capture> }
  const sendKey = ["community", "invite-send", serverId]
  const sender = useMutation({ meta: { observabilityAction: "invitation.send" },
    mutationKey: sendKey,
    gcTime: 0,
    mutationFn: async ({ userId, token, author, assert }: SendIntent) => {
      assert()
      const { conversation } = await createOrGetDm.mutateAsync({ userId, assertActive: assert })
      assert()
      const receipt = acceptDmMessage({ dmId: conversation.id, content: inviteUrl(token), author, assertActive: assert })
      await awaitCommittedInvite(receipt, () => { assert(); void captureProductAnalytics({ event: "human_invitation_sent" }, assert) })
      assert()
      ui.setState((state) => ({ ...state, invitedUserIds: new Set(state.invitedUserIds).add(userId) }))
    },
    onError: (error, intent) => {
      try { intent.assert() } catch { return }
      if (!isAbortError(error)) toast(error instanceof Error ? error.message : "Couldn't send invite")
    },
  })
  const pending = useMutationState({ filters: { mutationKey: sendKey, status: "pending" }, select: (mutation) => mutation.state.variables as SendIntent | undefined })
  const invitingUserIds = new Set(pending.filter((intent) => intent?.assert.signal === view.signal).map((intent) => intent!.userId))
  const copier = useMutation({ meta: { observabilityAction: "invitation.copy" },
    gcTime: 0,
    mutationFn: async ({ token, assert }: { token: string; assert: ReturnType<typeof view.capture> }) => {
      assert()
      await copyInviteLink(inviteUrl(token), (value) => { assert(); return navigator.clipboard.writeText(value) }, () => { assert(); void captureProductAnalytics({ event: "human_invitation_copied" }, assert) })
      assert()
      toast("Invite link copied")
    },
    onError: (_error, intent) => { try { intent.assert(); toast("Couldn't copy — copy manually") } catch {} },
  })
  const handleOpenChange = (next: boolean) => {
    if (!next) view.retire()
    onOpenChange(next)
  }
  const eligibleFriends = useMemo<Friend[]>(() => {
    const normalized = query.trim().toLowerCase()
    return friends.filter((friend) => !normalized || friend.name.toLowerCase().includes(normalized) || friend.sub.toLowerCase().includes(normalized))
  }, [friends, query])
  const pickerState = resolvePeoplePickerViewState({
    resolved: friendsQuery.data !== undefined,
    error: friendsQuery.isError,
    sourceCount: friends.length,
    visibleCount: eligibleFriends.length,
    query,
  })
  const inviteFriend = (friend: Friend) => {
    if (!token || !friend.userId || ui.get().invitedUserIds.has(friend.userId)) return
    const assert = view.capture()
    const pending = client.getMutationCache().findAll({ mutationKey: sendKey, status: "pending" })
    if (pending.some((mutation) => { const intent = mutation.state.variables as SendIntent | undefined; return intent && intent.userId === friend.userId && intent.assert.signal === assert.signal })) return
    sender.mutate({ userId: friend.userId, token, author: { id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar }, assert })
  }
  const copyLink = () => { if (token && !copier.isPending) copier.mutate({ token, assert: view.capture() }) }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-own-padding=""
        className="flex h-[max(75%,min(32rem,calc(100%-2rem)))] max-h-[calc(100%-2rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-120"
      >
        <PeoplePickerHeader
          title={`Invite friends to ${serverName}`}
          subtitle="Send a direct invite or share a link below."
        />

        <div className="px-5 pt-3 pb-2">
          <label className="relative block">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for friends"
              className="h-10 rounded-xl pl-9.5 text-sm"
            />
          </label>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto thin-scrollbar px-2 py-1.5">
          <PeoplePickerBody
            state={pickerState}
            loading={(
              <div data-slot="invite-friends-loading">
                <PeoplePickerRowsSkeleton secondaryLine actionClassName="w-16" />
              </div>
            )}
            errorMessage="Couldn't load friends."
            emptyMessage={friendsQuery.totalFriends === 0 ? "You don't have any friends to invite yet." : "No friends to invite — everyone you know is already here."}
            retrying={friendsQuery.data === undefined && friendsQuery.isFetching}
            onRetry={() => { void friendsQuery.refetch() }}
          >
            <div className="flex flex-col gap-0.5">
              {eligibleFriends.map((f) => {
                const invited = f.userId ? invitedUserIds.has(f.userId) : false
                const inviting = f.userId ? invitingUserIds.has(f.userId) : false
                return (
                  <InviteFriendRow
                    key={f.id}
                    friend={f}
                    tokenReady={Boolean(token)}
                    inviting={inviting}
                    invited={invited}
                    onInvite={(candidate) => void inviteFriend(candidate)}
                  />
                )
              })}
            </div>
          </PeoplePickerBody>
        </div>

        <footer
          data-slot="invite-link-well"
          className="mx-5 mt-2 mb-5 rounded-2xl px-4 py-3.5"
        >
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Link2 aria-hidden className="size-3.5 shrink-0" />
            <span>Or, send a server invite link to a friend</span>
          </div>
          {resolveError ? (
            <p className="mt-2 text-xs text-destructive">{resolveError}</p>
          ) : (
            <div className="mt-2.5 flex items-center gap-2">
              <Input
                readOnly
                value={token ? inviteUrl(token) : ""}
                placeholder={token ? "" : "Loading…"}
                className="h-9 font-mono text-xs"
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
