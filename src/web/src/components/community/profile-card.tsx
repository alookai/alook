"use client"

import { useState } from "react"
import { MessagesSquare, Shield } from "lucide-react"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Avatar } from "./avatar"
import type { Profile } from "./_types"
import type { Breakpoint } from "@/hooks/use-mobile"

// Deterministic, on-brand banner gradient. Hue is constrained to the warm band
// (60–80 per DESIGN.md) and chroma kept low so two profiles always read as the
// same family — distinct but never garish.
function generateGradient(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue1 = 60 + (Math.abs(hash) % 21)
  const hue2 = 60 + (Math.abs(hash * 7) % 21)
  return `linear-gradient(135deg, oklch(0.78 0.06 ${hue1}), oklch(0.68 0.05 ${hue2}))`
}

// Profile card — popover anchored at the click point on desktop, bottom sheet on mobile.
export function ProfileCard({ data, x, y, bp, onClose, onMessage, isSelf }: {
  data: Profile
  x: number
  y: number
  bp: Breakpoint
  onClose: () => void
  onMessage?: (name: string, text: string) => void
  isSelf?: boolean
}) {
  const [msg, setMsg] = useState("")
  const send = () => {
    const text = msg.trim()
    if (!text) return
    onMessage?.(data.name, text)
    setMsg("")
    onClose()
  }
  const mobile = bp === "mobile"
  const gradient = generateGradient(data.name)
  const card = (
    <>
      {/* banner */}
      <div className="-m-2 mb-0 h-16 rounded-t-lg" style={{ background: gradient }} />
      <div className="px-2 pb-2">
        <div className="-mt-8 mb-3 flex items-end justify-between">
          <div className="rounded-full ring-4 ring-popover">
            <Avatar label={data.avatar} size={64} />
          </div>
          <Badge variant="secondary" className="mb-1 h-6 gap-1"><Shield className="size-3.5" /> {data.role}</Badge>
        </div>
        <div className="rounded-lg bg-card p-4">
          <div className="text-lg font-semibold">
            {data.name}
            {data.discriminator && (
              <span className="ml-1 text-xs font-normal tracking-wide text-muted-foreground">
                #{data.discriminator}
              </span>
            )}
          </div>
          <Separator className="my-2" />
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">About</div>
          <p className="mt-1 text-sm text-muted-foreground">{data.about || "No bio yet."}</p>
          {data.mutual > 0 && (
            <>
              <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Mutual servers</div>
              <p className="mt-1 text-sm text-muted-foreground">{data.mutual} in common</p>
            </>
          )}
          {!isSelf && (
            <div className="mt-3 flex h-9 items-center gap-2 rounded-md bg-secondary px-2">
              <input
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") send() }}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                placeholder={`Message @${data.name}`}
              />
              <button onClick={send} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Send message">
                <MessagesSquare className="size-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )

  // mobile: bottom sheet (intentional mobile UX, kept manual)
  if (mobile)
    return (
      <div className="fixed inset-0 z-30 flex flex-col justify-end" onClick={onClose}>
        <div className="absolute inset-0 bg-foreground/30" />
        <div className="relative p-3" onClick={(e) => e.stopPropagation()}>
          <div className="overflow-hidden rounded-xl border border-border bg-popover p-2 shadow-(--e2)">{card}</div>
        </div>
      </div>
    )

  // desktop: shadcn Popover anchored to an invisible trigger at the click point
  return (
    <Popover open onOpenChange={(o) => { if (!o) onClose() }}>
      <PopoverTrigger
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none fixed size-0"
        style={{ left: x, top: y }}
      />
      <PopoverContent side="right" align="start" sideOffset={8} className="w-75 overflow-hidden p-2">
        {card}
      </PopoverContent>
    </Popover>
  )
}
