import type { MetadataRoute } from "next";
import type { BlogDiscoveryManifestV1 } from "@/lib/blog-discovery-manifest";
import { TEMPLATES } from "@/lib/templates";

const SITE_URL = "https://alook.ai";

export function buildRootSitemap(manifest: BlogDiscoveryManifestV1 | null): MetadataRoute.Sitemap {
	const templateEntries: MetadataRoute.Sitemap = TEMPLATES.map((template) => ({
		url: `${SITE_URL}/templates/${template.id}`,
		changeFrequency: "monthly",
		priority: 0.7,
	}));
	const posts = manifest?.posts ?? [];
	const blogEntries: MetadataRoute.Sitemap = posts.map((post) => ({
		url: `${SITE_URL}/blog/${post.slug}`,
		lastModified: post.dateModified ?? post.date,
		changeFrequency: "monthly",
		priority: 0.6,
	}));
	const latestBlogModification = posts.reduce<string | undefined>((latest, post) => {
		const modified = post.dateModified ?? post.date;
		return !latest || modified > latest ? modified : latest;
	}, undefined);

	return [
		{ url: SITE_URL, changeFrequency: "weekly", priority: 1 },
		{ url: `${SITE_URL}/templates`, changeFrequency: "weekly", priority: 0.8 },
		...templateEntries,
		...(manifest
			? [{
				url: `${SITE_URL}/blog`,
				...(latestBlogModification ? { lastModified: latestBlogModification } : {}),
				changeFrequency: "weekly" as const,
				priority: 0.8,
			}]
			: []),
		...blogEntries,
		{ url: `${SITE_URL}/privacy`, changeFrequency: "yearly", priority: 0.3 },
	];
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export function serializeRootSitemap(entries: MetadataRoute.Sitemap): string {
	const urls = entries.map((entry) => {
		const lastModified = entry.lastModified instanceof Date
			? entry.lastModified.toISOString()
			: entry.lastModified;
		return [
			"  <url>",
			`    <loc>${escapeXml(entry.url)}</loc>`,
			...(lastModified ? [`    <lastmod>${escapeXml(lastModified)}</lastmod>`] : []),
			...(entry.changeFrequency ? [`    <changefreq>${entry.changeFrequency}</changefreq>`] : []),
			...(entry.priority !== undefined ? [`    <priority>${entry.priority}</priority>`] : []),
			"  </url>",
		].join("\n");
	});
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		...urls,
		"</urlset>",
		"",
	].join("\n");
}
