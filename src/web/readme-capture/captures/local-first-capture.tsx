"use client"

import { LandingShellMotion } from "@/components/home/landing-shell-motion"

export function LocalFirstCapture() {
  return (
    <>
      <section id="capture-local" className="feature-canvas local-canvas capture-static">
        <LandingShellMotion
          scene="machine"
          beat={5}
          machineIntroDescription="Pair a machine to run an Alook agent with an installed, authenticated runtime. While the machine and daemon are online, the agent can receive messages beyond this browser tab."
        />
      </section>

      <style jsx global>{`
        .local-canvas [data-testid="landing-motion-stage"] {
          width: 1280px;
          height: 720px;
          aspect-ratio: auto;
        }

        .local-canvas [data-testid="landing-motion-stage"] > div {
          width: 870px !important;
          height: 489.375px !important;
          transform: scale(1.4712644) !important;
          transform-origin: top left !important;
        }

        .local-canvas [data-testid="landing-motion-stage"] > div > div {
          width: 870px !important;
          height: 489.375px !important;
        }
      `}</style>
    </>
  )
}
