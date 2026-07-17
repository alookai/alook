"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { avatarInitial } from "@/lib/community/avatar"
import { Skeleton } from "@/components/ui/skeleton"
import { useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

type InviteInfo = {
  serverName: string
  serverIcon: string | null
  memberCount: number
}

/**
 * Client-side invite acceptance flow.
 * Fetches invite info, displays server preview, and joins on button click.
 */
export function InviteAcceptClient({ token }: { token: string }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchInfo() {
      try {
        const data = await apiFetch<InviteInfo>(`/api/community/invites/${token}/info`)
        setInfo(data)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "This invite is no longer valid"
        setError(message)
      } finally {
        setLoading(false)
      }
    }
    fetchInfo()
  }, [token])

  const handleJoin = async () => {
    setJoining(true)
    try {
      const result = await apiFetch<{ serverId: string }>(`/api/community/invites/${token}/join`, {
        method: "POST",
      })
      toast("Joined server")
      // Refresh the server list before navigating so the rail shows the newly
      // joined server on arrival instead of the user having to refresh.
      await queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
      router.push(`/c/channels/${result.serverId}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Couldn't join the server — try the invite again"
      toast(message)
      setJoining(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-(--e2)">
          <Skeleton className="mx-auto size-20 rounded-full" />
          <Skeleton className="mx-auto mt-4 h-3 w-32 rounded" />
          <Skeleton className="mx-auto mt-3 h-5 w-48 rounded" />
          <Skeleton className="mx-auto mt-2 h-3 w-24 rounded" />
          <Skeleton className="mt-6 h-9 w-full rounded-md" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4">
        <div className="max-w-sm rounded-xl border border-border bg-card p-8 text-center shadow-(--e2)">
          <h1 className="text-xl font-semibold">This invite isn&apos;t working</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <p className="mt-1 text-xs text-muted-foreground">Ask whoever shared it for a fresh link.</p>
          <Button
            className="mt-6"
            variant="secondary"
            onClick={() => router.push("/c/me")}
          >
            Back to community
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4">
      <div className="max-w-sm rounded-xl border border-border bg-card p-8 text-center shadow-(--e2)">
        {/* Server icon / initial */}
        <div className="mx-auto mb-4 grid size-20 place-items-center rounded-full bg-muted">
          {info?.serverIcon ? (
            <img src={info.serverIcon} alt={info.serverName} className="size-20 rounded-full object-cover" />
          ) : (
            <span className="text-3xl font-semibold text-muted-foreground">
              {info ? avatarInitial(info.serverName) : "?"}
            </span>
          )}
        </div>

        {/* Server info */}
        <p className="text-xs font-medium text-muted-foreground">You&apos;re invited to join</p>
        <h1 className="mt-1 text-2xl font-semibold">{info?.serverName}</h1>
        {info?.memberCount != null && (
          <p className="mt-2 text-xs text-muted-foreground">
            {info.memberCount} {info.memberCount === 1 ? "member" : "members"}
          </p>
        )}

        {/* Join button */}
        <Button
          className="mt-6 w-full"
          onClick={handleJoin}
          disabled={joining}
        >
          {joining ? "Joining…" : "Join server"}
        </Button>
      </div>
    </div>
  )
}
