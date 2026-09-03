import type { Metadata, Viewport } from "next";
import { GoogleTagManager } from "@next/third-parties/google";
import { ThemeProvider } from "@/components/theme-provider";
import { ToasterProvider } from "@/components/toaster-provider";
import { MessageNotificationToaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MockNetworkBanner } from "@/components/mock-network-banner";
import { TauriThemeSync } from "@/components/tauri-theme-sync";
import { DesktopUpdateDialog } from "@/components/desktop-update-dialog";
import { ThemeColorSync } from "@/components/theme-color-sync";
import { siteMetadata, siteStructuredData, siteViewport } from "@/lib/seo/site-metadata";
import { caveat, dmMono, dmSans, instrumentSerif, literata, vt323 } from "./fonts";
import "./globals.css";

export const viewport: Viewport = siteViewport;
export const metadata: Metadata = siteMetadata;

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
            __html: JSON.stringify(siteStructuredData),
          }}
        />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <ThemeColorSync />
          <TauriThemeSync />
          <DesktopUpdateDialog />
          <MessageNotificationToaster />
          <TooltipProvider>
            {children}
          </TooltipProvider>
          <ToasterProvider />
        </ThemeProvider>
      </body>
    </html>
  );
}
