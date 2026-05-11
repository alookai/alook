import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { TEMPLATES, TEMPLATE_CATEGORIES } from "@/lib/templates";
import { TemplatesClient } from "./client";

export const metadata: Metadata = {
  title: "Templates",
  description:
    "Browse pre-built AI team templates. Deploy a full AI team in minutes — developers, content creators, research analysts, and more.",
};

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  const params = await searchParams;
  return (
    <TemplatesClient
      templates={TEMPLATES}
      categories={TEMPLATE_CATEGORIES}
      isLoggedIn={!!session}
      workspaceId={params.workspace_id}
    />
  );
}
