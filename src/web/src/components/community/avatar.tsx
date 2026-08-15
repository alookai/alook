import type React from "react"
import { AvatarBadge } from "@/components/ui/avatar"
import { ProfileAvatar } from "@/components/avatar"
import type { Presence } from "@/lib/community/models/people"

const STATUS_COLOR: Record<Presence, string> = {
  online: "var(--status-online)",
  // Not the reserved `--status-offline` red — DESIGN.md reserves that token
  // for the workspace agent-runtime disconnect badge (an alert-worthy
  // signal). A friend/bot simply being offline is a neutral state, so it
  // gets the same de-emphasized `muted-foreground` treatment the community
  // bot/machine lists use for their own offline dots — solid, not
  // translucent, so it stays a crisp dot rather than fading into whatever
  // sits behind the avatar.
  offline: "var(--muted-foreground)",
}

export function Avatar({ label, seed, src, size = 40, dim = false, presence, ringColor = "var(--background)" }: {
  label: string
  // Stable id the fallback shape avatar is derived from. Never a display name:
  // shape avatars must not shift on rename. When absent, we drop to a plain
  // single-letter fallback instead of synthesising a shape from `label`.
  seed?: string
  src?: string | null
  size?: number
  dim?: boolean
  presence?: Presence
  // The cutout ring around the presence dot must match whatever surface the
  // avatar actually sits on (a card, popover, muted panel, etc.) — not
  // always the page's global background — or it reads as a visible seam
  // instead of a clean cutout. Callers on a non-default surface should pass
  // e.g. `ringColor="var(--popover)"`.
  ringColor?: string
}) {
  return (
    <ProfileAvatar label={label} seed={seed} src={src} size={size} dim={dim} alt="">
      {presence && (
        <AvatarBadge
          data-presence={presence}
          style={{
            background: STATUS_COLOR[presence],
            // Scales with the avatar instead of a fixed 10px — on a small
            // 24-32px list avatar that's fine, but on ProfileCard's 64px
            // avatar a fixed dot reads as disproportionately tiny. Keep the
            // filled circle modest and let the cutout ring (below) carry
            // most of the size increase, or a bigger dot alone just looks
            // like an oversized blob.
            width: Math.round(size * 0.22),
            height: Math.round(size * 0.22),
            // Custom cutout ring instead of the `ring-2` default — scaled to
            // the same ratio as the avatar frame's own ring (`ring-4` on a
            // 64px avatar in profile-card.tsx, i.e. ~1/16th of the diameter)
            // so the dot's border reads as consistent with the avatar's.
            boxShadow: `0 0 0 ${Math.max(2, Math.round(size * 0.0625))}px ${ringColor}`,
          } as React.CSSProperties}
        />
      )}
    </ProfileAvatar>
  )
}
