"use client"

import { createStore, useSelector } from "@tanstack/react-store"
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query"
import type React from "react"
import { useEffect, useMemo } from "react"
import { Loader2, Search } from "lucide-react"
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
import { trackHumanInvitationCopied, trackHumanInvitationSent } from "@/lib/analytics"

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
    <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40">
      <Avatar
        label={friend.avatar || friend.name}
        seed={friend.userId}
        size={32}
        presence={friend.status}
        ringColor="var(--popover)"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{friend.name}</div>
        {hasStatus(friend.statusEmoji, friend.statusText) && (
          <div className="truncate text-xs text-muted-foreground">
            {friend.statusEmoji} {friend.statusText}
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

/**
 * Own one friend's complete invite lifecycle. The mutable set is updated
 * synchronously before React rerenders, so two rapid activations cannot start
 * duplicate DM/message chains. Other user ids remain independent.
 */
export async function runInviteFriend(
  userId: string,
  inFlightUserIds: Set<string>,
  sendInvite: () => Promise<void>,
  onInvited: (userId: string) => void,
  setInvitingUserIds: React.Dispatch<React.SetStateAction<Set<string>>>,
): Promise<boolean> {
  if (inFlightUserIds.has(userId)) return false

  inFlightUserIds.add(userId)
  setInvitingUserIds(new Set(inFlightUserIds))
  try {
    await sendInvite()
    onInvited(userId)
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Couldn't send invite"
    toast(msg)
    return false
  } finally {
    inFlightUserIds.delete(userId)
    setInvitingUserIds(new Set(inFlightUserIds))
  }
}

export async function awaitCommittedInvite(
  receipt: DmSendReceipt,
  onCommitted: () => void = trackHumanInvitationSent,
) {
  if (!receipt.accepted) throw new Error("Couldn't send invite")
  const committed = await receipt.committed
  if (!committed.ok) throw committed.error
  onCommitted()
}

export async function copyInviteLink(
  url: string,
  writeText: (value: string) => Promise<void>,
  onCopied: () => void = trackHumanInvitationCopied,
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
    const assert = view.capture()
    resolveInvite({ currentUserId: currentUser.id, assert })
  }, [open, currentResolution, view, currentUser.id, resolveInvite])

  type SendIntent = { userId: string; token: string; author: { id: string; name: string; avatar: string }; assert: ReturnType<typeof view.capture> }
  const sendKey = ["community", "invite-send", serverId]
  const sender = useMutation({
    mutationKey: sendKey,
    gcTime: 0,
    mutationFn: async ({ userId, token, author, assert }: SendIntent) => {
      assert()
      const { conversation } = await createOrGetDm.mutateAsync({ userId, assertActive: assert })
      assert()
      const receipt = acceptDmMessage({ dmId: conversation.id, content: inviteUrl(token), author, assertActive: assert })
      await awaitCommittedInvite(receipt, () => { assert(); trackHumanInvitationSent() })
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
  const copier = useMutation({
    gcTime: 0,
    mutationFn: async ({ token, assert }: { token: string; assert: ReturnType<typeof view.capture> }) => {
      assert()
      await copyInviteLink(inviteUrl(token), (value) => { assert(); return navigator.clipboard.writeText(value) }, () => { assert(); trackHumanInvitationCopied() })
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
    loading: friendsQuery.isLoading,
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
      <DialogContent className="flex h-96 max-h-[80vh] w-full flex-col gap-0 p-0 sm:max-w-md">
        <PeoplePickerHeader title={`Invite friends to ${serverName}`} />

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
          <PeoplePickerBody
            state={pickerState}
            loading={(
              <div data-slot="invite-friends-loading">
                <PeoplePickerRowsSkeleton secondaryLine actionClassName="w-16" />
              </div>
            )}
            errorMessage="Couldn't load friends."
            emptyMessage="No friends to invite — everyone you know is already here."
            retrying={friendsQuery.data === undefined && friendsQuery.isFetching}
            onRetry={() => { void friendsQuery.refetch() }}
          >
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
          </PeoplePickerBody>
        </div>

        <footer className="border-t border-border/50 px-4 py-3">
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
