"use client"

import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { avatarInitial } from "@/lib/community/avatar"
import { communityKeys } from "@/lib/query-keys"
import { useServers } from "@/hooks/community/use-servers"
import { useJoinServer } from "@/hooks/community/mutations/servers"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

type InviteInfo = {
  serverId: string
  serverName: string
  serverIcon: string | null
  memberCount: number
}

/**
 * Inline join card rendered for messages with `type === "community_invite"`.
 * The embed carries only the invite token; server metadata is fetched on
 * mount so the card stays live (revoked/expired invites render an error
 * state instead of showing stale info from a snapshot).
 */
export function CommunityInviteCard({ token }: { token: string }) {
  const router = useRouter()
  const { servers } = useServers()
  const joinServer = useJoinServer()

  const { data, isLoading, isError } = useQuery({
    queryKey: communityKeys.inviteInfo(token),
    queryFn: () => apiFetch<InviteInfo>(`/api/community/invites/${token}/info`),
    staleTime: 60_000,
    retry: false,
  })

  const alreadyMemberServerId = data
    ? servers.find((s) => s.id === data.serverId)?.id
    : undefined

  const onJoin = async () => {
    try {
      const result = await joinServer.mutateAsync({ inviteCode: token })
      toast("Joined server")
      router.push(`/c/channels/${result.serverId}`)
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Couldn't join the server — try again"
      toast(msg)
    }
  }

  // Border keeps the card visually distinct from the message row's hover
  // highlight (`bg-accent/40`), which sits very close to `bg-card`. The
  // parent MessageBody wraps the card in `pt-2 pb-2` so hover highlight
  // extends below the card — a bare `mb-*` on the card wouldn't do that
  // (it'd push the card out of the highlighted area instead).
  const cardBase = "flex max-w-100 items-center gap-3 rounded-md border border-border bg-card p-3"

  if (isLoading) {
    return (
      <div className={cardBase}>
        <Skeleton className="size-12 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-3 w-24 rounded" />
          <Skeleton className="h-3 w-16 rounded" />
        </div>
        <Skeleton className="h-8 w-16 rounded-md" />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className={`${cardBase} text-sm text-muted-foreground`}>
        This invite has expired or is no longer valid.
      </div>
    )
  }

  return (
    <div className={cardBase}>
      {data.serverIcon ? (
        <img
          src={data.serverIcon}
          alt={data.serverName}
          className="size-12 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <div className="grid size-12 shrink-0 place-items-center rounded-lg bg-primary text-lg font-semibold text-primary-foreground">
          {avatarInitial(data.serverName)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-muted-foreground">
          You&apos;ve been invited to join
        </div>
        <div className="truncate font-medium">{data.serverName}</div>
        <div className="text-xs text-muted-foreground">
          {data.memberCount} {data.memberCount === 1 ? "member" : "members"}
        </div>
      </div>
      {alreadyMemberServerId ? (
        <Button
          size="sm"
          onClick={() => router.push(`/c/channels/${alreadyMemberServerId}`)}
        >
          Go to Server
        </Button>
      ) : (
        <Button size="sm" onClick={onJoin} disabled={joinServer.isPending}>
          {joinServer.isPending ? "Joining…" : "Join"}
        </Button>
      )}
    </div>
  )
}
