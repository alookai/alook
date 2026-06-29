import type { Metadata, Viewport } from "next";
import {
  DM_Sans,
  DM_Mono,
  Instrument_Serif,
  Caveat,
  VT323,
  Literata,
} from "next/font/google";
import { GoogleTagManager } from "@next/third-parties/google";
import { ThemeProvider } from "@/components/theme-provider";
import { ToasterProvider } from "@/components/toaster-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MockNetworkBanner } from "@/components/mock-network-banner";
import { TauriThemeSync } from "@/components/tauri-theme-sync";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["400"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
});

const caveat = Caveat({
  variable: "--font-caveat",
  subsets: ["latin"],
  weight: ["700"],
});

const vt323 = VT323({
  variable: "--font-vt323",
  subsets: ["latin"],
  weight: ["400"],
});

const literata = Literata({
  variable: "--font-literata",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});


const SITE_URL = "https://alook.ai";
const OG_IMAGE_URL = "/og?title=Your Personal Company";

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
    default: "Alook — Personal Company",
    template: "%s — Alook",
  },
  description:
    "Your AI agents, always on. Give them an email, let them work for you around the clock.",
  icons: {
    icon: [
      {
        url: "/alook.svg",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/alook-dark.svg",
        media: "(prefers-color-scheme: dark)",
      },
    ],
  },
  openGraph: {
    type: "website",
    siteName: "Alook",
    title: "Alook — Personal Company",
    description:
      "Your AI agents, always on. Give them an email, let them work for you around the clock.",
    url: SITE_URL,
    images: [
      {
        url: OG_IMAGE_URL,
        width: 1200,
        height: 630,
        alt: "Alook — Your Personal Company",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@alook_ai",
    title: "Alook — Your Personal Company",
    description:
      "Your AI agents, always on. Give them an email, let them work for you around the clock.",
    images: [OG_IMAGE_URL],
  },
  alternates: {
    canonical: SITE_URL,
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
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
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
                description:
                  "Your AI agents, always on. Give them an email, let them work for you around the clock.",
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
