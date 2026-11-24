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
            isolation: isolate;
            transform: translateZ(0);
            width: 1280px;
            height: 720px;
            overflow: hidden;
            border-radius: 18px;
            background-color: var(--tn-paper);
            background-image:
              var(--tn-grain),
              linear-gradient(rgb(188 214 230 / 68%) 1px, transparent 1px),
              linear-gradient(90deg, rgb(188 214 230 / 68%) 1px, transparent 1px);
            background-size: 180px 180px, 28px 28px, 28px 28px;
            box-shadow: inset 0 0 0 1px rgb(185 166 126 / 52%);
          }

          .feature-canvas + .feature-canvas {
            margin-top: 40px;
          }

          .tn-window {
            overflow: hidden;
            border: 1px solid rgb(185 166 126 / 68%);
            border-radius: 14px;
            background: var(--background);
            box-shadow:
              0 24px 52px rgb(31 26 21 / 14%),
              0 6px 16px rgb(31 26 21 / 8%),
              inset 0 1px 0 rgb(255 255 255 / 88%);
          }

          .tn-sticker {
            border: 1px solid #d9cdb7;
            border-radius: 14px;
            background: var(--tn-paper-raised);
            box-shadow:
              0 22px 46px rgb(31 26 21 / 16%),
              0 6px 14px rgb(31 26 21 / 9%),
              0 0 0 4px rgb(255 253 248 / 92%);
          }

          .tn-room-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            border-bottom: 1px solid var(--border);
            background: var(--tn-paper);
            padding: 8px 14px;
          }

          .tn-room-server {
            font-family: var(--font-caveat), cursive;
            font-size: 20px;
            font-weight: 700;
            line-height: 1;
            color: var(--tn-ink);
          }

          .tn-room-sep {
            color: var(--tn-muted);
            font-size: 13px;
            opacity: 0.55;
          }

          .tn-room-channel {
            font-family: var(--font-dm-sans), system-ui, sans-serif;
            font-size: 13px;
            font-weight: 600;
            color: var(--tn-ink);
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
