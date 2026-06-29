import type React from "react"
import { Avatar as UiAvatar, AvatarImage, AvatarFallback, AvatarBadge } from "@/components/ui/avatar"
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar"
import type { Presence } from "./_types"

export const STATUS_COLOR: Record<Presence, string> = {
  online: "var(--status-online)",
  offline: "var(--status-offline)",
}

function isUrl(s: string) {
  return s.startsWith("http://") || s.startsWith("https://") || s.startsWith("/")
}

export function Avatar({ label, src, size = 40, dim = false, presence }: {
  label: string
  src?: string
  size?: number
  dim?: boolean
  presence?: Presence
}) {
  const avatarConfig = parseAvatarUrl(label)
  const imageUrl = src || (isUrl(label) ? label : undefined)

  return (
    <UiAvatar
      className="bg-muted"
      style={{ width: size, height: size, opacity: dim ? 0.4 : 1 }}
    >
      {imageUrl ? (
        <AvatarImage src={imageUrl} alt={label} />
      ) : avatarConfig ? (
        <AvatarRenderer config={avatarConfig} size={size} className="size-full" />
      ) : null}
      <AvatarFallback className="font-medium" style={{ fontSize: size * 0.4 }}>
        {label.charAt(0).toUpperCase()}
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
