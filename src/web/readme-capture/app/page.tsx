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
