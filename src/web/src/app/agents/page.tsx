import { AgentsHubView } from "@/components/agents/agents-hub-view"
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata"

export const metadata = buildPublicPageMetadata({
  title: "Supported AI Agents — Connect Local Runtimes to Alook",
  description: "Connect Claude Code, Codex, Cursor CLI, Antigravity, Grok Build, OpenCode, Pi, GitHub Copilot, and Qoder running on your own computer into shared Alook rooms.",
  path: "/agents",
})

export default function AgentsPage() {
  return <AgentsHubView />
}
