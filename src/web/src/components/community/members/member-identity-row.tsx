import type React from "react"
import { Avatar } from "../avatar"
import type { Presence } from "@/lib/community/models/people"
import { cn } from "@/lib/utils"

export function MemberIdentityRow({
  name,
  discriminator,
  avatarLabel,
  avatarSeed,
  avatarSrc,
  presence,
  dim = false,
  ringColor,
  secondary,
  className,
}: {
  name: string
  discriminator?: string | null
  avatarLabel: string
  avatarSeed?: string
  avatarSrc?: string | null
  presence?: Presence
  dim?: boolean
  ringColor?: string
  secondary?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-3", className)}>
      <Avatar
        label={avatarLabel}
        seed={avatarSeed}
        src={avatarSrc}
        size={32}
        presence={presence}
        dim={dim}
        ringColor={ringColor}
      />
      <div className="min-w-0 flex-1 space-y-0.5 text-left">
        <div className={cn("truncate text-sm leading-tight", dim && "text-muted-foreground")}>
          {name}
          {discriminator && (
            <span className="ml-1 text-xs font-normal tracking-wide text-muted-foreground">#{discriminator}</span>
          )}
        </div>
        {secondary && <div className="truncate text-xs leading-tight text-muted-foreground">{secondary}</div>}
      </div>
    </div>
  )
}
