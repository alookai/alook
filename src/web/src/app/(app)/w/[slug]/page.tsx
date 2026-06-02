import { redirect } from "next/navigation"

export default async function WorkspaceRootPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  redirect(`/w/${slug}/home`)
}
