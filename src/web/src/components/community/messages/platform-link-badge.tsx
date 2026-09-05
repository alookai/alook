import type { ComponentPropsWithoutRef } from "react"
import Image from "next/image"
import { Link2, MonitorDot } from "lucide-react"
import {
  SiAnthropic,
  SiArxiv,
  SiCloudflare,
  SiDevdotto,
  SiDiscord,
  SiFigma,
  SiGithub,
  SiGitlab,
  SiGoogledrive,
  SiHashnode,
  SiLinear,
  SiLoom,
  SiMedium,
  SiNotion,
  SiNpm,
  SiProducthunt,
  SiReddit,
  SiStackoverflow,
  SiSubstack,
  SiVercel,
  SiWikipedia,
  SiX,
  SiXiaohongshu,
  SiYcombinator,
  SiYoutube,
  SiZhihu,
} from "@icons-pack/react-simple-icons"
import type { PlatformLinkKind } from "@/lib/community/platform-link"
import { matchPlatformLink } from "@/lib/community/platform-link"
import { cn } from "@/lib/utils"
import { OpenAILogo } from "@/components/provider-logo"
import { MessageExternalLink } from "./message-external-link"

const ICONS = {
  github: SiGithub,
  gitlab: SiGitlab,
  x: SiX,
  reddit: SiReddit,
  youtube: SiYoutube,
  figma: SiFigma,
  notion: SiNotion,
  discord: SiDiscord,
  linear: SiLinear,
  "google-drive": SiGoogledrive,
  cloudflare: SiCloudflare,
  vercel: SiVercel,
  npm: SiNpm,
  loom: SiLoom,
  anthropic: SiAnthropic,
  stackoverflow: SiStackoverflow,
  "hacker-news": SiYcombinator,
  substack: SiSubstack,
  medium: SiMedium,
  "dev-community": SiDevdotto,
  hashnode: SiHashnode,
  "product-hunt": SiProducthunt,
  arxiv: SiArxiv,
  wikipedia: SiWikipedia,
  zhihu: SiZhihu,
  xiaohongshu: SiXiaohongshu,
} satisfies Record<Exclude<PlatformLinkKind, "alook" | "local" | "openai">, typeof SiGithub>

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
      <MessageExternalLink
        {...props}
        href={href}
        className={cn("platform-link-badge", className)}
        data-platform-link="generic"
        aria-label={props["aria-label"] ?? `Link: ${href}`}
      >
        <Link2 className="platform-link-badge-icon" aria-hidden="true" />
        <span className="platform-link-badge-label">{children}</span>
      </MessageExternalLink>
    )
  }

  const icon = (() => {
    if (platform.kind === "alook") {
      return (
        <Image
          src="/favicon.ico"
          alt=""
          width={16}
          height={16}
          unoptimized
          className="platform-link-badge-icon"
          aria-hidden="true"
        />
      )
    }

    if (platform.kind === "local") {
      return <MonitorDot className="platform-link-badge-icon" aria-hidden="true" />
    }

    if (platform.kind === "openai") {
      return <OpenAILogo className="platform-link-badge-icon" aria-hidden="true" />
    }

    const Icon = ICONS[platform.kind]
    return <Icon className="platform-link-badge-icon" aria-hidden="true" />
  })()

  return (
    <MessageExternalLink
      {...props}
      href={href}
      className={cn("platform-link-badge", className)}
      data-platform-link={platform.kind}
      aria-label={props["aria-label"] ?? `${platform.label}: ${href}`}
    >
      {icon}
      <span className="platform-link-badge-label">{children}</span>
    </MessageExternalLink>
  )
}
