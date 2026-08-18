"use client"

import { useState, type CSSProperties } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CollaborationCapture } from "../captures/collaboration-capture"
import { LocalFirstCapture } from "../captures/local-first-capture"
import { MemoryCapture } from "../captures/memory-capture"
import { OneIdentityCapture } from "../captures/one-identity-capture"
import { OverviewCapture } from "../captures/overview-capture"
import { ReachCapture } from "../captures/reach-capture"

export default function ReadmeCapturePage() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <main className="capture-page" style={{ colorScheme: "light" } as CSSProperties}>
        <OverviewCapture />
        <OneIdentityCapture />
        <MemoryCapture />
        <ReachCapture />
        <LocalFirstCapture />
        <CollaborationCapture />

        <style jsx global>{`
          html,
          body {
            margin: 0;
            background: transparent !important;
            scrollbar-width: none;
          }

          html::-webkit-scrollbar,
          body::-webkit-scrollbar {
            display: none;
          }

          .capture-page {
            --background: oklch(1 0 0);
            --app-bg: var(--background);
            --foreground: oklch(0.18 0.03 230);
            --card: oklch(1 0.003 80);
            --card-foreground: oklch(0.18 0.03 230);
            --popover: oklch(1 0.003 80);
            --popover-foreground: oklch(0.18 0.03 230);
            --primary: oklch(0.22 0.03 230);
            --primary-foreground: oklch(0.985 0.005 80);
            --secondary: oklch(0.96 0.006 80);
            --secondary-foreground: oklch(0.22 0.03 230);
            --muted: oklch(0.925 0.012 80);
            --muted-foreground: oklch(0.44 0.03 230);
            --accent: oklch(0.94 0.008 80);
            --accent-foreground: oklch(0.22 0.03 230);
            --border: oklch(0.86 0.01 80);
            --input: oklch(0.86 0.01 80);
            --ring: oklch(0.55 0.03 230);
            --status-online: oklch(0.72 0.19 145);
            --status-offline: oklch(0.65 0.2 25);
            --e1: 0 1px 2px oklch(0.3 0.02 60 / 6%);
            --e2: 0 10px 20px -6px oklch(0.3 0.02 60 / 18%);
            --sidebar: oklch(0.97 0.008 80);
            --sidebar-foreground: oklch(0.18 0.03 230);
            --sidebar-primary: oklch(0.22 0.03 230);
            --sidebar-primary-foreground: oklch(0.985 0.005 80);
            --sidebar-accent: oklch(0.91 0.015 80);
            --sidebar-accent-foreground: oklch(0.22 0.03 230);
            --sidebar-border: oklch(0.87 0.01 80);
            --sidebar-ring: oklch(0.55 0.03 230);
            width: 1280px;
            background: transparent;
            color: var(--foreground);
          }

          nextjs-portal {
            display: none !important;
          }

          .feature-canvas {
            position: relative;
            width: 1280px;
            height: 720px;
            overflow: hidden;
            border-radius: 18px;
            background: var(--background);
          }

          .feature-canvas + .feature-canvas {
            margin-top: 40px;
          }

          .shell-card {
            overflow: hidden;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--background);
            box-shadow: var(--shadow-sm);
          }

          .capture-static [data-testid="landing-motion-stage"] > div > div {
            transform: scale(1) !important;
            transform-origin: 560px 330px !important;
            transition: none !important;
          }

          .capture-static [data-testid="landing-motion-cursor"] {
            display: none !important;
          }
        `}</style>
      </main>
    </QueryClientProvider>
  )
}
