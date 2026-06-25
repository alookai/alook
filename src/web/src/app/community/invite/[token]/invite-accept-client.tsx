"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { apiFetch } from "@/lib/api/client"

type InviteInfo = {
  serverName: string
  serverIcon: string | null
  serverDescription: string
  memberCount: number
}

/**
 * Client-side invite acceptance flow.
 * Fetches invite info, displays server preview, and joins on button click.
 */
export function InviteAcceptClient({ token }: { token: string }) {
  const router = useRouter()
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
        const message = err instanceof Error ? err.message : "Invalid or expired invite"
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
      router.push(`/community/channels/${result.serverId}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to join server"
      toast(message)
      setJoining(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground">Loading invite...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4">
        <div className="max-w-sm rounded-xl border border-border bg-card p-8 text-center shadow-(--e2)">
          <h1 className="text-xl font-semibold">Invite Invalid</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Button
            className="mt-6"
            variant="secondary"
            onClick={() => router.push("/community/channels/@me")}
          >
            Go Home
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
            <span className="text-3xl font-bold text-muted-foreground">
              {info?.serverName.charAt(0).toUpperCase() ?? "?"}
            </span>
          )}
        </div>

        {/* Server info */}
        <p className="text-xs uppercase tracking-wide text-muted-foreground">You have been invited to join</p>
        <h1 className="mt-1 text-2xl font-semibold">{info?.serverName}</h1>
        {info?.serverDescription && (
          <p className="mt-2 text-sm text-muted-foreground">{info.serverDescription}</p>
        )}
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
          {joining ? "Joining..." : "Accept Invite"}
        </Button>
      </div>
    </div>
  )
}
