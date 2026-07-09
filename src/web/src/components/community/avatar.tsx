import type React from "react"
import { Avatar as UiAvatar, AvatarImage, AvatarFallback, AvatarBadge } from "@/components/ui/avatar"
import { AvatarRenderer, parseAvatarUrl, configFromName } from "@/components/avatar"
import type { Presence } from "./_types"

const STATUS_COLOR: Record<Presence, string> = {
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

  // Priority: image URL > explicit avatar-config (avatar:{...}) > name-derived
  // fallback config > single letter. Radix `AvatarFallback` renders whenever
  // no `AvatarImage` is present, so we must NOT emit it when we've already
  // drawn a shape avatar via `<span><AvatarRenderer/></span>` — otherwise both
  // stack on top of each other (see the "two-avatar-in-one-place" bug).
  return (
    <UiAvatar
      className={hasGenerated && !imageUrl ? "after:hidden" : "bg-muted"}
      style={{ width: size, height: size, opacity: dim ? 0.4 : 1 }}
    >
      {imageUrl ? (
        <>
          <AvatarImage src={imageUrl} alt={safeLabel} />
          <AvatarFallback className="font-medium" style={{ fontSize: size * 0.4 }}>
            {safeLabel.charAt(0).toUpperCase()}
          </AvatarFallback>
        </>
      ) : avatarConfig ? (
        // Shape avatar from the picker's serialized `avatar:{...}` config.
        <span className="size-full rounded-full overflow-hidden">
          <AvatarRenderer config={avatarConfig} size={size} className="size-full" />
        </span>
      ) : fallbackConfig ? (
        // No image, no config — synthesize one from the name so we never fall
        // back to the plain letter (matches the design system's shape-avatar
        // aesthetic).
        <span className="size-full rounded-full overflow-hidden">
          <AvatarRenderer config={fallbackConfig} size={size} className="size-full" />
        </span>
      ) : (
        <AvatarFallback className="font-medium" style={{ fontSize: size * 0.4 }}>
          {safeLabel.charAt(0).toUpperCase()}
        </AvatarFallback>
      )}
      {presence === "online" && (
        <AvatarBadge
          className="size-2.5 ring-background"
          style={{ background: STATUS_COLOR.online } as React.CSSProperties}
        />
      )}
    </UiAvatar>
  )
}
