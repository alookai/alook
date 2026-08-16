import type { Metadata, Viewport } from "next";
import { GoogleTagManager } from "@next/third-parties/google";
import { ThemeProvider } from "@/components/theme-provider";
import { ToasterProvider } from "@/components/toaster-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MockNetworkBanner } from "@/components/mock-network-banner";
import { TauriThemeSync } from "@/components/tauri-theme-sync";
import { BRAND_DESCRIPTION, BRAND_SLOGAN, BRAND_TITLE } from "@/lib/brand-copy";
import { caveat, dmMono, dmSans, instrumentSerif, literata, vt323 } from "./fonts";
import "./globals.css";

const SITE_URL = "https://alook.ai";
const OG_IMAGE_URL = "/og?title=Share%20your%20agents%20with%20people%20you%20trust";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-visual",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ede7dd" },
    { media: "(prefers-color-scheme: dark)", color: "#262320" },
  ],
};

export const metadata: Metadata = {
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
        url: OG_IMAGE_URL,
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
    images: [OG_IMAGE_URL],
  },
  alternates: {
    canonical: SITE_URL,
    types: {
      "text/markdown": "/llms.txt",
    },
  },
};

export default function RootLayout({
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
        <script dangerouslySetInnerHTML={{ __html: `
          document.addEventListener('gesturestart', function(e) { e.preventDefault(); });
        `}} />
      </head>
      <GoogleTagManager gtmId="GTM-56VHCCQZ" />
      <body
        className="min-h-full flex flex-col"
      >
        <MockNetworkBanner />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify([
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
                "@type": "Organization",
                name: "Alook",
                url: SITE_URL,
                logo: `${SITE_URL}/alook.svg`,
                contactPoint: {
                  "@type": "ContactPoint",
                  email: "support@alook.ai",
                  contactType: "customer support",
                },
              },
            ]),
          }}
        />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TauriThemeSync />
          <TooltipProvider>
            {children}
          </TooltipProvider>
          <ToasterProvider />
        </ThemeProvider>
      </body>
    </html>
  );
}
