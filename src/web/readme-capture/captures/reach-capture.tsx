"use client"

import {
  LandingMobileChatMotion,
  LandingShellMotion,
} from "@/components/home/landing-shell-motion"

export function ReachCapture() {
  return (
    <>
      <section id="capture-reach" className="feature-canvas reach-canvas capture-static">
        <div className="shell-card reach-desktop">
          <LandingShellMotion scene="server" beat={6} />
        </div>
        <div className="reach-phone">
          <LandingMobileChatMotion beat={6} />
        </div>
      </section>

      <style jsx global>{`
        .reach-canvas {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 24px;
        }

        .reach-desktop {
          width: 884px;
          height: 672px;
        }

        .reach-desktop header > span[aria-label] {
          display: none !important;
        }

        .reach-desktop [data-testid="landing-motion-stage"] {
          width: 884px;
          height: 672px;
          aspect-ratio: auto;
        }

        .reach-desktop [data-testid="landing-motion-stage"] > div {
          width: 724px !important;
          height: 550px !important;
          transform: scale(1.22) !important;
          transform-origin: top left !important;
        }

        .reach-desktop [data-testid="landing-motion-stage"] > div > div {
          width: 724px !important;
          height: 550px !important;
          transform-origin: 362px 275px !important;
        }

        .reach-phone {
          display: flex;
          width: 332px;
          height: 672px;
          align-items: center;
          overflow: hidden;
          border: 3px solid var(--foreground);
          border-radius: 30px;
          background: var(--background);
          box-shadow: var(--shadow-sm);
        }

        .reach-phone [data-testid="landing-mobile-motion-stage"] {
          width: 100%;
        }

        .reach-phone [data-testid="landing-mobile-motion-stage"] > div {
          width: 343px !important;
          height: 693px !important;
          transform: scale(0.9504) !important;
          transform-origin: top left !important;
        }

        .reach-phone [class*="mobileTop"] {
          height: 35px !important;
        }

        .reach-phone [class*="mobileSurface"] {
          height: 658px !important;
        }
      `}</style>
    </>
  )
}
