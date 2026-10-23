import { notFound } from "next/navigation"
import { isCommunityApplicationPath } from "@/lib/community/application-route"

export default async function CommunityRoute({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  if (!isCommunityApplicationPath(`/c/${path.map(encodeURIComponent).join("/")}`)) notFound()
  return null
}
