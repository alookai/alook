"use client"

import { useMemo } from "react"
import type React from "react"
import { useRouter } from "next/navigation"
import { ServerPill } from "./inline-marks"
import { resolveServerRefBase } from "@/lib/community/channel-ref"
import { useChannelRefDirectory } from "@/hooks/community/use-channel-ref-directory"

export type ServerRefPillView =
  | { kind: "plain"; text: string }
  | { kind: "pill"; label: string; serverId: string }

/**
 * Bare `/server` refs are far more likely to collide with unrelated text
 * (`/tmp`, `/api`, `/docs`) than `/server/channel` — a two-segment ref is
 * distinctive, a one-segment one is not. So the pill only renders when we've
 * positively resolved the slug against the loaded directory. Any ambiguous
 * or still-loading case falls through to plain text — a directory-load flash
 * turning `/tmp` into a muted pill and back is worse than never highlighting
 * it at all.
 */
export function describeServerRefPillView(args: {
  ref: string
  resolved: { id: string; name: string } | null
}): ServerRefPillView {
  const { ref, resolved } = args
  if (!resolved) return { kind: "plain", text: ref }
  return { kind: "pill", label: resolved.name, serverId: resolved.id }
}

/**
 * Connected shell for a bare `/server` ref — mirrors `ChannelRefPill`'s
 * shape. Navigates to the server's default view (no channel segment).
 */
export function ServerRefPill({ children }: { children?: React.ReactNode }) {
  const ref = String(children ?? "")
  const router = useRouter()
  const { directory } = useChannelRefDirectory()

  const resolved = useMemo(() => resolveServerRefBase(directory, ref), [directory, ref])

  const view = describeServerRefPillView({ ref, resolved })

  if (view.kind === "plain") return <>{view.text}</>

  return (
    <ServerPill onClick={() => router.push(`/c/channels/${view.serverId}`)}>
      {view.label}
    </ServerPill>
  )
}
