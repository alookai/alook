import { CompareHubView } from "@/components/compare/compare-hub-view"
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata"

export const metadata = buildPublicPageMetadata({
  title: "Alook vs. Other AI Agents — Honest Comparisons",
  description: "Compare Alook with MyClaw, OpenClaw, Grok Bot, Slack AI Agents, Buzz, and Paperclip across local execution, billing, privacy, and team rooms.",
  path: "/compare",
})

export default function ComparePage() {
  return <CompareHubView />
}
