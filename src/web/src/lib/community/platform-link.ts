export type PlatformLinkKind =
  | "alook"
  | "local"
  | "github"
  | "gitlab"
  | "x"
  | "reddit"
  | "youtube"
  | "figma"
  | "notion"
  | "discord"
  | "linear"
  | "google-drive"
  | "cloudflare"
  | "vercel"
  | "npm"
  | "loom"
  | "openai"
  | "anthropic"
  | "stackoverflow"
  | "hacker-news"
  | "substack"
  | "medium"
  | "dev-community"
  | "hashnode"
  | "product-hunt"
  | "arxiv"
  | "wikipedia"
  | "zhihu"
  | "xiaohongshu"

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
  { kind: "gitlab", label: "GitLab", domains: ["gitlab.com"] },
  { kind: "x", label: "X", domains: ["x.com", "twitter.com"] },
  { kind: "reddit", label: "Reddit", domains: ["reddit.com", "redd.it"] },
  { kind: "youtube", label: "YouTube", domains: ["youtube.com", "youtu.be"] },
  { kind: "figma", label: "Figma", domains: ["figma.com"] },
  { kind: "notion", label: "Notion", domains: ["notion.so", "notion.site"] },
  { kind: "discord", label: "Discord", domains: ["discord.com", "discord.gg"] },
  { kind: "linear", label: "Linear", domains: ["linear.app"] },
  { kind: "google-drive", label: "Google Drive", domains: ["drive.google.com", "docs.google.com"] },
  { kind: "cloudflare", label: "Cloudflare", domains: ["cloudflare.com"] },
  { kind: "vercel", label: "Vercel", domains: ["vercel.com", "vercel.app"] },
  { kind: "npm", label: "npm", domains: ["npmjs.com"] },
  { kind: "loom", label: "Loom", domains: ["loom.com"] },
  { kind: "openai", label: "OpenAI", domains: ["openai.com", "chatgpt.com"] },
  { kind: "anthropic", label: "Anthropic", domains: ["anthropic.com", "claude.ai", "claude.com"] },
  { kind: "stackoverflow", label: "Stack Overflow", domains: ["stackoverflow.com"] },
  { kind: "hacker-news", label: "Hacker News", domains: ["news.ycombinator.com"] },
  { kind: "substack", label: "Substack", domains: ["substack.com"] },
  { kind: "medium", label: "Medium", domains: ["medium.com"] },
  { kind: "dev-community", label: "DEV Community", domains: ["dev.to"] },
  { kind: "hashnode", label: "Hashnode", domains: ["hashnode.com"] },
  { kind: "product-hunt", label: "Product Hunt", domains: ["producthunt.com"] },
  { kind: "arxiv", label: "arXiv", domains: ["arxiv.org"] },
  { kind: "wikipedia", label: "Wikipedia", domains: ["wikipedia.org"] },
  { kind: "zhihu", label: "Zhihu", domains: ["zhihu.com"] },
  { kind: "xiaohongshu", label: "Xiaohongshu", domains: ["xiaohongshu.com", "xhslink.com"] },
]

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function isLocalDevelopmentHost(host: string): boolean {
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "0.0.0.0"
    || host === "[::1]"
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
    || /^127(?:\.\d{1,3}){3}$/.test(host)
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
  if (isLocalDevelopmentHost(host)) return { kind: "local", label: "Local" }

  const definition = PLATFORM_DEFINITIONS.find(({ domains }) =>
    domains.some((domain) => hostMatchesDomain(host, domain)),
  )

  return definition ? { kind: definition.kind, label: definition.label } : null
}
