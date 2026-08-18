"use client"

import { LandingShellMotion } from "@/components/home/landing-shell-motion"

export function MemoryCapture() {
  return (
    <>
      <section id="capture-memory" className="feature-canvas memory-canvas capture-static">
        <div className="shell-card memory-frame">
          <LandingShellMotion scene="continuity" beat={6} />
        </div>
        <div className="shell-card memory-frame hide-server-crumb">
          <LandingShellMotion scene="continuity" beat={9} />
        </div>
      </section>

      <style jsx global>{`
        .memory-canvas {
          display: grid;
          align-content: start;
          gap: 16px;
          padding: 24px;
        }

        .memory-frame {
          width: 1232px;
          height: 328px;
        }

        .memory-frame [data-testid="landing-motion-stage"] {
          width: 1232px;
        }

        .hide-server-crumb header > span[aria-label] {
          display: none !important;
        }

        .memory-frame:first-child [class*="inboxSurface"] {
          display: none !important;
        }

        .memory-frame:first-child [data-motion-target^="continuity-dm-"] {
          opacity: 1 !important;
        }

        .memory-frame div.flex-1.overflow-hidden.px-4.py-3:has([data-motion-target="continuity-dm-gus"]),
        .memory-frame div.flex-1.overflow-hidden.px-4.py-3:has([data-motion-target="continuity-work-alli"]) {
          width: 71.4286%;
          padding-top: 0 !important;
          transform: scale(1.4) !important;
          transform-origin: top left !important;
        }

        .memory-frame [data-motion-target="continuity-dm-gus"] > .group,
        .memory-frame [data-motion-target="continuity-work-alli"] > .group {
          margin-top: 0 !important;
        }
      `}</style>
    </>
  )
}
