import type React from "react"
import { Avatar as UiAvatar, AvatarImage, AvatarFallback, AvatarBadge } from "@/components/ui/avatar"
import { AvatarRenderer, parseAvatarUrl, configFromName } from "@/components/avatar"
import type { Presence } from "./_types"

export const STATUS_COLOR: Record<Presence, string> = {
  online: "var(--status-online)",
  offline: "var(--status-offline)",
}

function isUrl(s: string | undefined | null): boolean {
  return !!s && (s.startsWith("http://") || s.startsWith("https://") || s.startsWith("/"))
}

export function Avatar({ label, src, size = 40, dim = false, presence }: {
  label: string
  src?: string
  size?: number
  dim?: boolean
  presence?: Presence
}) {
  const safeLabel = label || "?"
  const avatarConfig = parseAvatarUrl(safeLabel)
  const imageUrl = src || (isUrl(safeLabel) ? safeLabel : undefined)
  const fallbackConfig = !imageUrl && !avatarConfig ? configFromName(safeLabel) : null
  const hasGenerated = !!avatarConfig || !!fallbackConfig

  return (
    <UiAvatar
      className={hasGenerated && !imageUrl ? "after:hidden" : "bg-muted"}
      style={{ width: size, height: size, opacity: dim ? 0.4 : 1 }}
    >
      {imageUrl ? (
        <AvatarImage src={imageUrl} alt={safeLabel} />
      ) : avatarConfig ? (
        <span className="size-full rounded-full overflow-hidden">
          <AvatarRenderer config={avatarConfig} size={size} className="size-full" />
        </span>
      ) : null}
      <AvatarFallback className="font-medium" style={{ fontSize: size * 0.4 }}>
        {fallbackConfig ? (
          <span className="size-full rounded-full overflow-hidden">
            <AvatarRenderer config={fallbackConfig} size={size} className="size-full" />
          </span>
        ) : (
          safeLabel.charAt(0).toUpperCase()
        )}
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
