"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { CircleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { avatarInitial } from "@/lib/community/avatar"
import { Skeleton } from "@/components/ui/skeleton"
import { apiFetch } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { ServerIcon } from "@/components/community/server-icon"
import { Avatar } from "@/components/community/avatar"

type InviteInfo = {
  serverId: string
  serverName: string
  serverIcon: string | null
  serverDescription: string
  memberCount: number
  memberPreview: { id: string; avatar: string }[]
  inviter: { id: string; name: string; avatar: string } | null
}

// The invite is dead (revoked / expired / used up) vs. merely unreachable. A
// 404/410 is a definitively-gone link — worth its own "this has expired" copy
// so the user asks for a fresh one instead of retrying; anything else is a
// generic failure.
function isDeadInvite(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 410)
}

/**
 * Client-side invite acceptance flow.
 * Fetches invite info, displays server preview, and joins on button click.
 */
export function InviteAcceptClient({ token }: { token: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<{ message: string; dead: boolean } | null>(null)

  useEffect(() => {
    async function fetchInfo() {
      try {
        const data = await apiFetch<InviteInfo>(`/api/community/invites/${token}/info`)
        setInfo(data)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "This invite is no longer valid"
        setError({ message, dead: isDeadInvite(err) })
      } finally {
        setLoading(false)
      }
    }
    fetchInfo()
  }, [token])

  const handleJoin = useCallback(async () => {
    setJoining(true)
    // Raw fetch (not the shared `apiFetch`): apiFetch has a GLOBAL 401 handler
    // that hard-navigates to a bare `/sign-in` (no redirect param) before we
    // can react — which would drop the visitor at the default post-login page
    // (/workspaces → /studio/new) instead of back here. Preview-first needs the
    // 401 to route to sign-in WITH a return path, so we handle status ourselves.
    try {
      const res = await fetch(`/api/community/invites/${token}/join`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })

      // Not signed in → bounce to sign-in carrying an `autojoin=1` return path
      // so the join resumes automatically once they're back. The visitor clicks
      // Join exactly once.
      if (res.status === 401) {
        const returnTo = `/c/invite/${token}?autojoin=1`
        router.push(`/sign-in?redirect=${encodeURIComponent(returnTo)}`)
        return
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast(body?.error || "Couldn't join the server — try the invite again")
        setJoining(false)
        return
      }

      const result = (await res.json()) as { serverId: string }
      toast("Joined server")
      // Navigate into the joined server. This page renders standalone (outside
      // CommunityShell / its QueryProvider), so there's no community query cache
      // to invalidate here — arriving at /c/channels mounts the shell fresh and
      // its server list fetches on mount.
      router.push(`/c/channels/${result.serverId}`)
    } catch {
      toast("Couldn't join the server — try the invite again")
      setJoining(false)
    }
  }, [token, router])

  // Returning from the login wall (`?autojoin=1`) → resume the Join the visitor
  // already clicked. A ref latch fires it EXACTLY once per landing: a bare
  // `!joining` guard isn't enough because `info`'s reference can change (a
  // refetch / parent re-render) and re-run the effect before `joining` state
  // has settled, double-firing the join (a real member-row insert). The ref
  // flips synchronously on first fire and never resets, so re-renders are inert.
  const autojoin = searchParams.get("autojoin") === "1"
  const autojoinFired = useRef(false)
  useEffect(() => {
    if (autojoin && info && !autojoinFired.current) {
      autojoinFired.current = true
      handleJoin()
    }
  }, [autojoin, info, handleJoin])

  if (loading) {
    return (
      <Shell>
        <Skeleton className="size-21 rounded-2xl" />
        <Skeleton className="mt-5 h-3 w-32 rounded" />
        <Skeleton className="mt-3 h-7 w-48 rounded" />
        <Skeleton className="mt-4 h-4 w-64 rounded" />
        <Skeleton className="mt-6 h-11 w-full rounded-xl" />
      </Shell>
    )
  }

  if (error) {
    return (
      <Shell>
        <div className="grid size-16 place-items-center rounded-full bg-destructive/10 text-destructive">
          <CircleAlert className="size-7" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold">
          {error.dead ? "This invite has expired" : "This invite isn't working"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {error.dead
            ? "Invite links can run out or be turned off. Ask whoever shared it for a fresh one."
            : error.message}
        </p>
        <Button className="mt-6" variant="secondary" onClick={() => router.push("/c/me")}>
          Back to Alook
        </Button>
      </Shell>
    )
  }

  return (
    <Shell>
      {info && (
        <ServerIcon
          id={info.serverId}
          name={info.serverName}
          initial={avatarInitial(info.serverName)}
          icon={info.serverIcon}
          size={84}
          className="rounded-2xl"
        />
      )}

      <p className="mt-5 text-xs font-medium text-muted-foreground">You&apos;re invited to join</p>
      <h1 className="mt-1 font-brand text-4xl leading-tight font-bold">{info?.serverName}</h1>

      {info?.serverDescription && (
        <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">{info.serverDescription}</p>
      )}

      {info?.inviter && (
        <div className="mt-4 flex items-center gap-1.5 text-sm text-muted-foreground">
          <span>Invited by</span>
          <Avatar label={info.inviter.avatar} seed={info.inviter.id} size={20} />
          <span className="font-medium text-foreground">{info.inviter.name}</span>
        </div>
      )}

      <Button className="mt-6 h-11 w-full rounded-xl text-base" onClick={handleJoin} disabled={joining}>
        {joining ? "Joining…" : "Join server"}
      </Button>

      {/* Members footer — avatar strip + count below the CTA as a quiet
          "who's already here" footer (no divider), then the reassurance line. */}
      {info && info.memberCount > 0 && (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          {info.memberPreview.length > 0 && (
            <div className="flex items-center -space-x-1.5">
              {info.memberPreview.map((m) => (
                <Avatar key={m.id} label={m.avatar} seed={m.id} size={20} ringColor="var(--background)" />
              ))}
              {info.memberCount > info.memberPreview.length && (
                <span className="z-10 grid h-5 min-w-5 place-items-center rounded-full bg-muted px-1 pb-1 text-[0.825rem] font-bold leading-none text-muted-foreground ring-2 ring-background">
                  …
                </span>
              )}
            </div>
          )}
          <span>
            {info.memberCount} {info.memberCount === 1 ? "member" : "members"}
          </span>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">Free to join · leave anytime</p>
    </Shell>
  )
}

// Frameless landing shell — full-screen centered content, no floating card
// (the old bordered `bg-card` box). Everything the flow renders (loading /
// error / ready) shares this frame so the layout doesn't shift between states.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
      <div className="flex w-full max-w-sm flex-col items-center">{children}</div>
    </div>
  )
}
