import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { CompareDetailView } from "@/components/compare/compare-detail-view"
import { COMPARE_PAGES, getComparisonPage } from "@/lib/compare"
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata"

export function generateStaticParams() {
  return COMPARE_PAGES.map(({ slug }) => ({ slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const page = getComparisonPage(slug)
  if (!page) return {}
  return buildPublicPageMetadata({
    title: `Alook vs ${page.competitorName} — Which AI Agent Workspace Fits You?`,
    description: page.heroDescription,
    path: `/compare/${page.slug}`,
  })
}

export default async function CompareDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const page = getComparisonPage(slug)
  if (!page) notFound()
  return <CompareDetailView page={page} />
}
