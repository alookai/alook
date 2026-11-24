import { Box, Hash, Link2, MessageSquare, Network } from "@/components/icons/lucide"
import { ProviderLogo } from "@/components/provider-logo"
import type { ComparisonPage } from "@/lib/compare"

export function CompetitorMark({
  mark,
  className = "h-5 w-5",
}: {
  mark: ComparisonPage["competitorMark"]
  className?: string
}) {
  switch (mark) {
    case "openclaw":
      return <ProviderLogo provider="openclaw" className={className} />
    case "grok":
      return <ProviderLogo provider="grok" className={className} />
    case "slack":
      return <Hash className={className} aria-hidden="true" />
    case "paperclip":
      return <Link2 className={className} aria-hidden="true" />
    case "buzz":
      return <MessageSquare className={className} aria-hidden="true" />
    case "myclaw":
      return <Network className={className} aria-hidden="true" />
    default:
      return <Box className={className} aria-hidden="true" />
  }
}
