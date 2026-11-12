import technostalgia from "@/components/brand/technostalgia.module.css";
import { ObservedRouteCommit } from "@/lib/observability/regions";
import type { Metadata, Viewport } from "next";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { ThemeProvider } from "@/components/theme-provider";
import { ToasterProvider } from "@/components/toaster-provider";
import { MessageNotificationToaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MockNetworkBanner } from "@/components/mock-network-banner";
import { NativeKeyboardSync } from "@/hooks/use-native-keyboard";
import { TauriThemeSync } from "@/components/tauri-theme-sync";
import { ThemeColorSync } from "@/components/theme-color-sync";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { siteMetadata, siteStructuredData, siteViewport } from "@/lib/seo/site-metadata";
import { communityShellLayoutBootstrapScript } from "@/components/community/shell/shell-frame-geometry";
import { businessDocumentVersionBootstrapScript } from "@/lib/service-worker/business-upgrade";
import { WEB_BUILD_ID } from "@/lib/web-build";
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
        <meta name="alook-web-build" content={WEB_BUILD_ID} />
        <script dangerouslySetInnerHTML={{ __html: businessDocumentVersionBootstrapScript }} />
        <script dangerouslySetInnerHTML={{ __html: communityShellLayoutBootstrapScript }} />
        <link rel="manifest" href="/manifest.json" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <script dangerouslySetInnerHTML={{ __html: `
          document.addEventListener('gesturestart', function(e) { e.preventDefault(); });
        `}} />
      </head>
      <body
        className={`${technostalgia.theme} min-h-full flex flex-col`}
      >
        <div data-slot="app-safe-bounds" aria-hidden className="app-safe-viewport app-safe-overlay-viewport pointer-events-none invisible fixed" />
        <div data-alook-native-caption="" data-tauri-drag-region="" aria-hidden className="app-native-caption" />
        <MockNetworkBanner />
        <ServiceWorkerRegistration />
        {siteStructuredData.map((schema) => (
          <script
            key={schema["@type"]}
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(schema),
            }}
          />
        ))}
        <ThemeProvider attribute={["class", "data-tn-mode"]} defaultTheme="system" enableSystem>
          <ThemeColorSync />
          <TauriThemeSync />
          <NativeKeyboardSync />
          <MessageNotificationToaster />
          <TooltipProvider>
            {children}
          </TooltipProvider>
          <ToasterProvider />
          <ObservedRouteCommit />
        <AnalyticsConsent />
        </ThemeProvider>
      </body>
    </html>
  );
}
