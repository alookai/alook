import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { getTemplateById } from "@/lib/templates";
import { TemplateDetailClient } from "./client";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const template = getTemplateById(id);
  if (!template) return { title: "Not Found" };
  return {
    title: `${template.name} — Templates`,
    description: template.description,
  };
}

export default async function TemplateDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const template = getTemplateById(id);
  if (!template) notFound();

  const session = await getSession();
  const sp = await searchParams;
  return (
    <TemplateDetailClient
      template={template}
      isLoggedIn={!!session}
      workspaceId={sp.workspace_id}
    />
  );
}
