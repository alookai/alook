import type { ComponentPropsWithoutRef } from "react"
import { Link2 } from "lucide-react"
import {
  SiDiscord,
  SiFigma,
  SiGithub,
  SiNotion,
  SiReddit,
  SiX,
  SiYoutube,
} from "@icons-pack/react-simple-icons"
import type { PlatformLinkKind } from "@/lib/community/platform-link"
import { matchPlatformLink } from "@/lib/community/platform-link"
import { cn } from "@/lib/utils"

const ICONS = {
  github: SiGithub,
  x: SiX,
  reddit: SiReddit,
  youtube: SiYoutube,
  figma: SiFigma,
  notion: SiNotion,
  discord: SiDiscord,
} satisfies Record<PlatformLinkKind, typeof SiGithub>

type PlatformLinkBadgeProps = ComponentPropsWithoutRef<"a"> & {
  node?: unknown
}

/** Streamdown anchor renderer: every link becomes an inline badge. */
export function PlatformLinkBadge({
  children,
  className,
  href,
  node: _node,
  ...props
}: PlatformLinkBadgeProps) {
  const platform = matchPlatformLink(href)
  if (!platform) {
    return (
      <a
        {...props}
        href={href}
        className={cn("platform-link-badge", className)}
        data-platform-link="generic"
        aria-label={props["aria-label"] ?? `Link: ${href}`}
      >
        <Link2 className="platform-link-badge-icon" aria-hidden="true" />
        <span className="platform-link-badge-label">{children}</span>
      </a>
    )
  }

  const Icon = ICONS[platform.kind]
  return (
    <a
      {...props}
      href={href}
      className={cn("platform-link-badge", className)}
      data-platform-link={platform.kind}
      aria-label={props["aria-label"] ?? `${platform.label}: ${href}`}
    >
      <Icon className="platform-link-badge-icon" aria-hidden="true" />
      <span className="platform-link-badge-label">{children}</span>
    </a>
  )
}
