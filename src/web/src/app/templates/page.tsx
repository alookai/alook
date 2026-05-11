import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { TEMPLATES, TEMPLATE_CATEGORIES } from "@/lib/templates";
import { TemplatesClient } from "./client";

const description =
  "Browse pre-built AI team templates. Deploy a full AI team in minutes — developers, content creators, research analysts, and more.";

export const metadata: Metadata = {
  title: "Templates",
  description,
  alternates: { canonical: "https://alook.ai/templates" },
  openGraph: {
    title: "AI Team Templates — Alook",
    description,
    url: "https://alook.ai/templates",
    images: [{ url: "/og?title=AI Team Templates", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Team Templates — Alook",
    description,
    images: ["/og?title=AI Team Templates"],
  },
};

const itemListJsonLd = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "AI Team Templates",
  description,
  numberOfItems: TEMPLATES.length,
  itemListElement: TEMPLATES.map((template, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: template.name,
    description: template.description,
    url: `https://alook.ai/templates/${template.id}`,
  })),
};

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  const params = await searchParams;
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
      />
      <TemplatesClient
        templates={TEMPLATES}
        categories={TEMPLATE_CATEGORIES}
        isLoggedIn={!!session}
        workspaceId={params.workspace_id}
      />
    </>
  );
}
