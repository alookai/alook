export type PlatformLinkKind =
  | "alook"
  | "github"
  | "x"
  | "reddit"
  | "youtube"
  | "figma"
  | "notion"
  | "discord"

export type PlatformLinkMatch = {
  kind: PlatformLinkKind
  label: string
}

type PlatformDefinition = PlatformLinkMatch & {
  domains: readonly string[]
}

const PLATFORM_DEFINITIONS: readonly PlatformDefinition[] = [
  { kind: "alook", label: "Alook", domains: ["alook.ai"] },
  { kind: "github", label: "GitHub", domains: ["github.com"] },
  { kind: "x", label: "X", domains: ["x.com", "twitter.com"] },
  { kind: "reddit", label: "Reddit", domains: ["reddit.com", "redd.it"] },
  { kind: "youtube", label: "YouTube", domains: ["youtube.com", "youtu.be"] },
  { kind: "figma", label: "Figma", domains: ["figma.com"] },
  { kind: "notion", label: "Notion", domains: ["notion.so", "notion.site"] },
  { kind: "discord", label: "Discord", domains: ["discord.com", "discord.gg"] },
]

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/**
 * Classifies a fully-qualified HTTP(S) URL using hostname boundaries only.
 * No request, metadata lookup, redirect resolution, or storage is involved.
 */
export function matchPlatformLink(href: string | undefined): PlatformLinkMatch | null {
  if (!href) return null

  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null

  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  const definition = PLATFORM_DEFINITIONS.find(({ domains }) =>
    domains.some((domain) => hostMatchesDomain(host, domain)),
  )

  return definition ? { kind: definition.kind, label: definition.label } : null
}
