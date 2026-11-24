import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { AgentDetailView } from "@/components/agents/agent-detail-view"
import { AGENT_RUNTIME_PAGES, getAgentRuntimePage } from "@/lib/agents"
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata"

export function generateStaticParams() {
  return AGENT_RUNTIME_PAGES.map(({ slug }) => ({ slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const agent = getAgentRuntimePage(slug)
  if (!agent) return {}
  return buildPublicPageMetadata({
    title: `${agent.name} in Alook — Local Multi-Agent Collaboration`,
    description: agent.heroDescription,
    path: `/agents/${agent.slug}`,
  })
}

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const agent = getAgentRuntimePage(slug)
  if (!agent) notFound()
  return <AgentDetailView agent={agent} />
}
