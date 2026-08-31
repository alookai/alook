import type { Metadata, Viewport } from "next";
import { BRAND_DESCRIPTION, BRAND_SLOGAN, BRAND_TITLE } from "@/lib/brand-copy";
import { ALOOK_ORGANIZATION } from "@/lib/seo/entities";

export const SITE_URL = "https://alook.ai";
export const SITE_OG_IMAGE_URL = "/og";

export const siteViewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	maximumScale: 1,
	userScalable: false,
	viewportFit: "cover",
	interactiveWidget: "resizes-visual",
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#ffffff" },
		{ media: "(prefers-color-scheme: dark)", color: "#100d0a" },
	],
};

export const siteMetadata: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: {
		default: BRAND_TITLE,
		template: "%s — Alook",
	},
	description: BRAND_DESCRIPTION,
	icons: {
		icon: [{ url: "/favicon.ico", type: "image/x-icon" }],
		apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
	},
	openGraph: {
		type: "website",
		siteName: "Alook",
		title: BRAND_TITLE,
		description: BRAND_DESCRIPTION,
		url: SITE_URL,
		images: [
			{
				url: SITE_OG_IMAGE_URL,
				width: 1200,
				height: 630,
				alt: BRAND_TITLE,
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		site: "@alook_ai",
		title: BRAND_TITLE,
		description: BRAND_DESCRIPTION,
		images: [SITE_OG_IMAGE_URL],
	},
	alternates: {
		canonical: SITE_URL,
		types: {
			"text/markdown": "/llms.txt",
		},
	},
};

export const siteStructuredData = [
	{
		"@context": "https://schema.org",
		"@type": "WebApplication",
		name: "Alook",
		url: SITE_URL,
		slogan: BRAND_SLOGAN,
		description: BRAND_DESCRIPTION,
		applicationCategory: "DeveloperApplication",
		operatingSystem: "All",
		offers: {
			"@type": "Offer",
			price: "0",
			priceCurrency: "USD",
		},
	},
	{
		"@context": "https://schema.org",
		...ALOOK_ORGANIZATION,
	},
];
