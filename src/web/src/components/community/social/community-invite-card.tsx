"use client"

import { useCommunityRouter } from "@/contexts/community/module-route"
import { useUiHandlers } from "@/stores/community"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { avatarInitial } from "@/lib/community/avatar"
import { ServerIcon } from "../server-icon"
import { communityKeys } from "@/lib/query-keys"
import { useServers } from "@/hooks/community/use-servers"
import { useJoinServer } from "@/hooks/community/mutations/servers"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { tid } from "@/lib/community/testids"
import type { MessagePerspective } from "@/components/community/messages/message-presentation-types"
import { inviteInfoReadSchema, type InviteInfoWindow } from "@/lib/community/directory-window-persistence"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { ApiError, isAbortError } from "@/lib/errors"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"

export function resolveInviteCardPresentation(
  perspective: MessagePerspective,
  alreadyMember: boolean,
): { eyebrow: string; action: "join" | "open" | null } {
  if (perspective === "sender") return { eyebrow: "Invite sent", action: null }
  if (perspective === "neutral") return { eyebrow: "Server invite", action: null }
  return {
    eyebrow: "You've been invited to join",
    action: alreadyMember ? "open" : "join",
  }
}

export function CommunityInviteCard({
  token,
  perspective,
}: {
  token: string
  perspective: MessagePerspective
}) {
  const router = useCommunityRouter()
  const client = useQueryClient()
  const view = useCommunityViewSource("invite-card:" + token)
  const uiHandlers = useUiHandlers()
  const { servers } = useServers()
  const joinServer = useJoinServer()

  const query = useQuery({
    queryKey: communityKeys.inviteInfo(token),
    queryFn: async ({ signal }) => {
      const original = captureCommunityLiveSnapshotToken(client)
      const key = communityKeys.inviteInfo(token)
      const resource = client.getQueryCache().find({ queryKey: key, exact: true })
      const assert = () => {
        assertCommunityLiveSnapshotTokenCurrent(client, original, signal)
        if (resource && client.getQueryCache().find({ queryKey: key, exact: true }) !== resource) throw new DOMException("Retired invite card", "AbortError")
      }
      await original.registry?.ready
      const auxiliaryReadEpoch = await original.registry?.captureAuxiliaryReadEpoch()
      assert()
      try {
        const data = inviteInfoReadSchema.parse(await apiFetch<unknown>(`/api/community/invites/${encodeURIComponent(token)}/info`, communityRequestOptions(client, original, signal, assert)))
        assert()
        return { ...data, observed: true, ...(auxiliaryReadEpoch ? { auxiliaryReadEpoch } : {}) }
      } catch (error) {
        assert()
        if (error instanceof ApiError && [404, 410].includes(error.status)) {
          await original.registry!.retireAuxiliaryDisk([{ kind: "invite", id: token }])
          assert()
          if (resource && client.getQueryCache().find({ queryKey: key, exact: true }) === resource) resource.setState({ data: undefined, dataUpdatedAt: 0 })
        }
        throw error
      }
    },
    staleTime: 60_000,
    retry: false,
  })
  const { data, isLoading, isError } = query
  const isCurrentInfo = () => {
    const current = client.getQueryState<InviteInfoWindow>(communityKeys.inviteInfo(token))
    return !!data && current?.status === "success" && !current.isInvalidated && current.data === data && current.data.observed === true
  }
  const currentInfo = isCurrentInfo()
  const rejected = query.error instanceof ApiError && [404, 410].includes(query.error.status)

  const alreadyMemberServerId = data
    ? servers.find((s) => s.id === data.serverId)?.id
    : undefined
  const presentation = resolveInviteCardPresentation(
    perspective,
    !!alreadyMemberServerId,
  )

  const onJoin = async () => {
    if (!isCurrentInfo()) return
    const assert = view.tryCapture()
    if (!assert) return
    uiHandlers.cancelPendingNavigation?.()
    try {
      const result = await joinServer.mutateAsync({ inviteCode: token })
      assert()
      toast("Joined server")
      router.push(`/c/channels/${result.serverId}`)
    } catch (err) {
      try { assert() } catch { return }
      if (isAbortError(err)) return
      const msg =
        err instanceof Error ? err.message : "Couldn't join the server — try again"
      toast(msg)
    }
  }

  const cardBase = "flex max-w-100 items-center gap-2 rounded-md border border-border bg-card p-2"

  if (isLoading) {
    return (
      <div
        className={cardBase}
        data-testid={tid.inviteCard(token)}
        data-perspective={perspective}
      >
        <Skeleton className="size-12 shrink-0 rounded-lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Skeleton className="h-3 w-32 rounded" />
          <Skeleton className="h-4 w-24 rounded" />
          <Skeleton className="h-3 w-16 rounded" />
        </div>
        {perspective === "recipient" && <Skeleton className="h-8 w-16 rounded-md" />}
      </div>
    )
  }

  if (!data) {
    return (
      <div
        className={`${cardBase} text-sm text-muted-foreground`}
        data-testid={tid.inviteCard(token)}
        data-perspective={perspective}
      >
        <span>{rejected ? "This invite has expired or is no longer valid." : "Couldn't load invite."}</span>
        {!rejected && <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => { void query.refetch() }}>{query.isFetching ? "Retrying…" : "Retry"}</Button>}
      </div>
    )
  }

  return (
    <div
      className={cardBase}
      data-testid={tid.inviteCard(token)}
      data-perspective={perspective}
    >
      <ServerIcon
        id={data.serverId}
        name={data.serverName}
        initial={avatarInitial(data.serverName)}
        icon={data.serverIcon}
        size={48}
        className="shrink-0 rounded-lg"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-xs font-medium text-muted-foreground">
          {presentation.eyebrow}
        </div>
        <div className="truncate font-medium">{data.serverName}</div>
        <div className="text-xs text-muted-foreground">
          {data.memberCount} {data.memberCount === 1 ? "member" : "members"}
        </div>
        {isError && <div className="text-xs text-muted-foreground">{rejected ? "This invite has expired or is no longer valid." : "Couldn't refresh invite."}</div>}
      </div>
      {presentation.action === "open" && alreadyMemberServerId ? (
        <Button
          size="sm"
          data-testid={tid.inviteCardAction(token)}
          onClick={() => {
            uiHandlers.cancelPendingNavigation?.()
            router.push(`/c/channels/${alreadyMemberServerId}`)
          }}
        >
          Go to Server
        </Button>
      ) : presentation.action === "join" ? (
        <Button
          size="sm"
          data-testid={tid.inviteCardAction(token)}
          onClick={onJoin}
          disabled={!currentInfo || joinServer.isPending}
        >
          {joinServer.isPending ? "Joining…" : "Join"}
        </Button>
      ) : null}
      {isError && <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => { void query.refetch() }}>{query.isFetching ? "Retrying…" : "Retry"}</Button>}
    </div>
  )
}
