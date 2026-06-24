import type React from "react"
import { Avatar as UiAvatar, AvatarImage, AvatarFallback, AvatarBadge } from "@/components/ui/avatar"
import type { Presence } from "./_types"

export const STATUS_COLOR: Record<Presence, string> = {
  online: "var(--status-online)",
  offline: "var(--status-offline)",
}

// Avatar — thin wrapper over the shadcn ui/avatar (Base UI). Renders the image when
// `src` is given, falling back to the `label` initials otherwise (or on load error) via
// AvatarFallback. Keeps a numeric `size` (px) because this UI needs precise sizes
// (24/32/40/64/68…) beyond the ui avatar's sm/default/lg tiers; the exact px is applied
// via style and overrides the default size-8.
//
// `presence` renders a status dot via ui AvatarBadge (ring-cutout). Offline renders
// nothing — presence is never signaled by color alone (callers also dim offline rows).
export function Avatar({ label, src, size = 40, dim = false, presence }: {
  label: string
  src?: string
  size?: number
  dim?: boolean
  presence?: Presence
}) {
  return (
    <UiAvatar
      className="bg-muted"
      style={{ width: size, height: size, opacity: dim ? 0.4 : 1 }}
    >
      {src && <AvatarImage src={src} alt={label} />}
      <AvatarFallback className="font-medium" style={{ fontSize: size * 0.4 }}>
        {label}
      </AvatarFallback>
      {presence === "online" && (
        <AvatarBadge
          className="size-2.5 ring-background"
          style={{ background: STATUS_COLOR.online } as React.CSSProperties}
        />
      )}
    </UiAvatar>
  )
}
