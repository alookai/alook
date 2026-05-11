import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { getTemplateById } from "@/lib/templates";
import { TemplateDetailClient } from "./client";

const SITE_URL = "https://alook.ai";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const template = getTemplateById(id);
  if (!template) return { title: "Not Found" };

  const title = `${template.name} — AI Team Templates`;
  const url = `${SITE_URL}/templates/${id}`;
  const ogImage = `/og?title=${encodeURIComponent(template.name)}`;

  return {
    title,
    description: template.description,
    keywords: template.tags,
    alternates: { canonical: url },
    openGraph: {
      title,
      description: template.description,
      url,
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: template.description,
      images: [ogImage],
    },
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

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: template.name,
      description: template.longDescription,
      applicationCategory: "BusinessApplication",
      operatingSystem: "All",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      keywords: template.tags.join(", "),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Templates", item: `${SITE_URL}/templates` },
        { "@type": "ListItem", position: 3, name: template.name, item: `${SITE_URL}/templates/${id}` },
      ],
    },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <TemplateDetailClient
        template={template}
        isLoggedIn={!!session}
        workspaceId={sp.workspace_id}
      />
    </>
  );
}
