import { redirect } from "next/navigation";

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  redirect(`/w/${slug}/agents/${id}/chat`);
}
