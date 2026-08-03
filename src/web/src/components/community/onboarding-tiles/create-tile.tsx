"use client"

import { useRef } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { TileDefs, tileIds } from "./tile-defs"
import { OT_EASE, comeOnline } from "./tile-motion"

// "Create your first bot" — an empty dashed slot with a plus morphs into a live
// avatar that comes online, recomposes into the app's real message row, and posts
// its first message ("Hello World"), then loops back to the empty slot.
export function CreateTile({ idPrefix = "ot-create" }: { idPrefix?: string }) {
  const ref = useRef<SVGSVGElement>(null)
  const id = tileIds(idPrefix)

  useGSAP(
    () => {
      const scope = ref.current
      if (!scope) return
      gsap.set(".ot-bot", { opacity: 0, scale: 0.9 })
      gsap.set(".ot-dot", { opacity: 0 })
      gsap.set(".ot-say", { opacity: 0 })
      gsap.set(".ot-av", { x: 0, y: 0, scale: 1, svgOrigin: "100 65" })
      const tl = gsap.timeline({ repeat: -1, defaults: { ease: OT_EASE } })
      // ACT 1: empty slot → centered avatar appears
      tl.fromTo(".ot-plus", { scale: 0.9 }, { scale: 1.12, duration: 0.9, yoyo: true, repeat: 1 })
        .to(".ot-ph", { opacity: 0, scale: 1.06, duration: 0.55 }, "+=0.15")
        .to(".ot-bot", { opacity: 1, scale: 1, duration: 0.55 }, "<")
      comeOnline(tl, ".ot-dot", 120.5, 85.5, "-=0.1")
      // ACT 2: recompose into the real message row + post first message
      tl.to(".ot-av", { scale: 0.77, x: -50, y: -4, duration: 0.6, svgOrigin: "100 65" }, "+=0.5")
        .from(".ot-say", { x: -8, duration: 0.5 }, "<0.15")
        .to(".ot-say", { opacity: 1, duration: 0.4 }, "<")
        .to({}, { duration: 1.6 })
        // loop back to the empty slot
        .to(".ot-say", { opacity: 0, x: -8, duration: 0.4 })
        .to(".ot-av", { scale: 0.9, x: 0, y: 0, duration: 0.45, svgOrigin: "100 65" }, "<0.1")
        .to(".ot-bot", { opacity: 0, duration: 0.4 })
        .set(".ot-dot", { opacity: 0 })
        .set(".ot-av", { scale: 1 })
        .to(".ot-ph", { opacity: 1, scale: 1, duration: 0.5 }, "<0.1")
        .to({}, { duration: 0.5 })
    },
    { scope: ref }
  )

  return (
    <svg ref={ref} viewBox="0 0 200 130" className="ot-svg h-full w-full">
      <TileDefs idPrefix={idPrefix} />
      <g className="ot-ph ot-center">
        <rect className="ot-art" x="74" y="39" width="52" height="52" rx="16" strokeDasharray="7 7" opacity="0.65" />
        <g className="ot-plus ot-center">
          <line className="ot-art" x1="100" y1="55" x2="100" y2="75" />
          <line className="ot-art" x1="90" y1="65" x2="110" y2="65" />
        </g>
      </g>
      <g className="ot-bot ot-center" opacity="0">
        <g className="ot-av">
          <svg x="74" y="39" width="52" height="52" viewBox="0 0 36 36">
            <g clipPath={`url(#${id.disc})`}>
              <use href={`#${id.faceB}`} />
            </g>
          </svg>
          <g className="ot-online">
            <circle cx="120.5" cy="85.5" r="8.5" fill="var(--card)" />
            <circle cx="120.5" cy="85.5" r="5.5" fill="var(--muted-foreground)" />
            <circle className="ot-dot" cx="120.5" cy="85.5" r="5.5" fill="var(--status-online)" />
          </g>
        </g>
        <g className="ot-say" opacity="0">
          <text x="82" y="60" fontFamily="DM Sans, sans-serif" fontSize="15" fontWeight="600" fill="var(--foreground)">Alli</text>
          <text x="112" y="60" fontFamily="DM Sans, sans-serif" fontSize="12" fill="var(--muted-foreground)">now</text>
          <text x="82" y="80" fontFamily="DM Sans, sans-serif" fontSize="15" fill="var(--foreground)">Hello World</text>
        </g>
      </g>
    </svg>
  )
}
