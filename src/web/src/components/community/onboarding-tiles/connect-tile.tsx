"use client"

import { useRef } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { TileDefs, tileIds } from "./tile-defs"
import { OT_EASE } from "./tile-motion"

// "Connect your machine" — Alook is the HUB (top); your computer (bottom-left)
// and phone (bottom-right) each link only THROUGH Alook (no device↔device edge).
// A green dot circulates computer → Alook → phone → Alook → computer, always
// routing through the hub, pulsing a flare at each node on arrival. This reads
// as "your local bot, reachable from your phone or anywhere". Nodes stay still;
// edges are trimmed sub-segments of the dot's path so nothing overlaps the icons.
const AL = { x: 100, y: 32 }
const PC = { x: 57, y: 96 }
const PH = { x: 143, y: 96 }

export function ConnectTile({ idPrefix = "ot-connect" }: { idPrefix?: string }) {
  const ref = useRef<SVGSVGElement>(null)
  const id = tileIds(idPrefix)

  useGSAP(
    () => {
      const scope = ref.current
      if (!scope) return
      // flare pulse at a node: an expanding+fading ring + a brightness blip
      const flareAt = (tl: gsap.core.Timeline, nodeSel: string, x: number, y: number) => {
        tl.set(".ot-flare", { attr: { cx: x, cy: y, r: 3 }, opacity: 0.9 })
          .to(".ot-flare", { attr: { r: 12 }, opacity: 0, duration: 0.7, ease: "power2.out" })
          .to(nodeSel, { filter: "brightness(1.7)", duration: 0.14, ease: "power2.out" }, "<")
          .to(nodeSel, { filter: "brightness(1)", duration: 0.6, ease: "power1.out" }, "<0.14")
      }
      // one leg: dot rides the edge center-to-center, lands, flares
      const leg = (tl: gsap.core.Timeline, from: typeof AL, to: typeof AL, nodeSel: string) => {
        tl.set(".ot-packet", { attr: { cx: from.x, cy: from.y, r: 4 }, opacity: 0 })
          .to(".ot-packet", { opacity: 1, duration: 0.2 })
          .to(".ot-packet", { attr: { cx: to.x, cy: to.y }, duration: 0.85, ease: "power1.inOut" })
          .to(".ot-packet", { opacity: 0, duration: 0.14 })
        flareAt(tl, nodeSel, to.x, to.y)
        tl.to({}, { duration: 0.25 })
      }
      const tl = gsap.timeline({ repeat: -1, defaults: { ease: OT_EASE } })
      leg(tl, PC, AL, ".ot-alook") // computer → Alook
      leg(tl, AL, PH, ".ot-phone") // Alook → phone
      leg(tl, PH, AL, ".ot-alook") // phone → Alook (back through hub)
      leg(tl, AL, PC, ".ot-machine") // Alook → computer
      tl.to({}, { duration: 0.3 })
    },
    { scope: ref }
  )

  return (
    <svg ref={ref} viewBox="0 0 200 130" className="ot-svg h-full w-full">
      <TileDefs idPrefix={idPrefix} />
      {/* connectors: exact sub-segments (38%–70%) of each Alook↔device center line,
          so the dot rides right on the line; equal length, gap at both ends. */}
      <line className="ot-art" x1="83.7" y1="56.3" x2="70.1" y2="76.8" opacity="0.28" />
      <line className="ot-art" x1="116.3" y1="56.3" x2="129.9" y2="76.8" opacity="0.28" />
      {/* Alook hub (top) — neutral foreground color, like the logo everywhere else */}
      <g className="ot-alook ot-center text-foreground">
        <svg x="83" y="15" width="34" height="34" viewBox="3 5 22 22">
          <use href={`#${id.alook}`} />
        </svg>
      </g>
      {/* your computer (bottom-left) */}
      <g className="ot-machine ot-center">
        <svg x="40" y="79" width="34" height="34" viewBox="0 0 24 24">
          <use href={`#${id.monitor}`} />
        </svg>
      </g>
      {/* your phone (bottom-right) */}
      <g className="ot-phone ot-center">
        <svg x="130" y="83" width="26" height="26" viewBox="0 0 24 24">
          <use href={`#${id.phone}`} />
        </svg>
      </g>
      {/* flare ring (pulses at whichever node the dot reaches) + the traveling dot */}
      <circle className="ot-art ot-accent ot-flare" cx="100" cy="32" r="4" opacity="0" strokeWidth="2.5" />
      <circle className="ot-art-fill ot-accent ot-packet" cx="100" cy="32" r="4" opacity="0" />
    </svg>
  )
}
