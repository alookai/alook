"use client"

import { LandingShellMotion } from "@/components/home/landing-shell-motion"

export function OverviewCapture() {
  return (
    <>
      <section
        id="capture-overview"
        className="feature-canvas overview-canvas capture-static"
        style={{ width: 1182, height: 797 }}
      >
        <LandingShellMotion scene="server" beat={6} overviewDetails />
      </section>

      <style jsx global>{`
        .overview-canvas {
          width: 1182px;
          height: 797px;
        }

        .overview-canvas header > span[aria-label] {
          display: none !important;
        }

        .overview-canvas [data-testid="landing-motion-stage"] {
          width: 1182px;
          height: 797px;
          aspect-ratio: auto;
        }

        .overview-canvas [data-testid="landing-motion-stage"] > div {
          width: 816px !important;
          height: 550px !important;
          transform: scale(1.4485) !important;
          transform-origin: top left !important;
        }

        .overview-canvas [data-testid="landing-motion-stage"] > div > div {
          width: 816px !important;
          height: 550px !important;
          transform-origin: 408px 275px !important;
        }
      `}</style>
    </>
  )
}
