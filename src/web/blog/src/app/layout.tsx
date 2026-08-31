import { GoogleTagManager } from "@next/third-parties/google";
import type { Metadata, Viewport } from "next";
import { caveat, dmMono, dmSans, instrumentSerif, literata, vt323 } from "@/app/fonts";
import { ThemeColorSync } from "@/components/theme-color-sync";
import { ThemeProvider } from "@/components/theme-provider";
import { siteMetadata, siteStructuredData, siteViewport } from "@/lib/seo/site-metadata";
import "./globals.css";

export const viewport: Viewport = siteViewport;
export const metadata: Metadata = siteMetadata;

export default function BlogRootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html
			lang="en"
			className={`${dmSans.variable} ${dmMono.variable} ${instrumentSerif.variable} ${caveat.variable} ${vt323.variable} ${literata.variable} h-full antialiased`}
			suppressHydrationWarning
		>
			<head>
				<link rel="manifest" href="/manifest.json" />
				<meta name="mobile-web-app-capable" content="yes" />
				<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
			</head>
			<GoogleTagManager gtmId="GTM-56VHCCQZ" />
			<body className="min-h-full flex flex-col">
				<script
					type="application/ld+json"
					dangerouslySetInnerHTML={{ __html: JSON.stringify(siteStructuredData) }}
				/>
				<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
					<ThemeColorSync />
					{children}
				</ThemeProvider>
			</body>
		</html>
	);
}
