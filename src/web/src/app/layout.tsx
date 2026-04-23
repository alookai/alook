import type { Metadata } from "next";
import {
  DM_Sans,
  DM_Mono,
  Caveat,
  Bricolage_Grotesque,
  VT323,
  Literata,
} from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeScript } from "@/components/theme-script";
import { ToasterProvider } from "@/components/toaster-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
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

const caveat = Caveat({
  variable: "--font-caveat",
  subsets: ["latin"],
  weight: ["700"],
});

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
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

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Alook — Always-on AI Agents",
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
    title: "Alook — Always-on AI Agents",
    description:
      "Your AI agents, always on. Give them an email, let them work for you around the clock.",
    url: SITE_URL,
    images: [
      {
        url: "/api/og?title=Always-on AI Agents",
        width: 1200,
        height: 630,
        alt: "Alook — Always-on AI Agents",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Alook — Always-on AI Agents",
    description:
      "Your AI agents, always on. Give them an email, let them work for you around the clock.",
    images: ["/api/og?title=Always-on AI Agents"],
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
      className={`${dmSans.variable} ${dmMono.variable} ${caveat.variable} ${bricolage.variable} ${vt323.variable} ${literata.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-full flex flex-col">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
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
            }),
          }}
        />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TooltipProvider>
            {children}
          </TooltipProvider>
          <ToasterProvider />
        </ThemeProvider>
      </body>
    </html>
  );
}
