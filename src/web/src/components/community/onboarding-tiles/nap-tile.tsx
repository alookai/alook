"use client"

import { useRef } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { TileDefs, tileIds } from "./tile-defs"
import { OT_EASE, comeOnline, goOffline } from "./tile-motion"

// "Nap" — the context meter is a RING around the agent. It fills 0→100% and the
// agent's breathing slows (getting heavier); then it sleeps (dims, dot offline,
// moon + zzz rise), the ring empties back to 0% while asleep, and it wakes with a
// clean context (relights, breathing back to normal speed).
export function NapTile({ idPrefix = "ot-nap" }: { idPrefix?: string }) {
  const ref = useRef<SVGSVGElement>(null)
  const id = tileIds(idPrefix)

  useGSAP(
    () => {
      const scope = ref.current
      if (!scope) return
      const C = 188.5 // ring circumference (2π·30)
      const ringEl = scope.querySelector(".ot-ring") as SVGCircleElement
      const pctEl = scope.querySelector(".ot-pct") as SVGTextElement
      gsap.set(".ot-sleep", { opacity: 0, y: 4 })
      gsap.set(".ot-dot", { opacity: 1 })
      gsap.set(ringEl, { attr: { "stroke-dashoffset": C } })
      pctEl.textContent = "context 0%"
      const br = gsap.to(".ot-agent", { scale: 1.03, duration: 2, ease: OT_EASE, yoyo: true, repeat: -1, transformOrigin: "center" })

      const ctx = { v: 0 }
      const sync = () => {
        pctEl.textContent = "context " + Math.round(ctx.v) + "%"
        ringEl.setAttribute("stroke-dashoffset", (C * (1 - ctx.v / 100)).toFixed(1))
      }
      const tl = gsap.timeline({ repeat: -1, defaults: { ease: OT_EASE } })
      // FILL: ring fills 0→100%, % ticks up, breathe slows
      tl.to(ctx, {
        v: 100,
        duration: 3.2,
        ease: "power1.in",
        onUpdate: () => {
          sync()
          br.timeScale(1 - (ctx.v / 100) * 0.7)
        },
      })
        .to({}, { duration: 0.5 })
        // SLEEP: agent dims, dot offline, moon + zzz rise
        .to(".ot-agent", { opacity: 0.32, duration: 0.5 })
        .to(".ot-sleep", { opacity: 0.9, y: -6, duration: 0.9, ease: "power1.out" }, "<0.1")
      goOffline(tl, ".ot-dot", 112, 71, "<")
      // CLEAR: while asleep the ring empties back to 0% (fresh)
      tl.to(ctx, { v: 0, duration: 0.7, ease: "power2.inOut", onUpdate: sync }, "<0.1")
        .to(".ot-sleep", { opacity: 0, duration: 0.4 })
        // WAKE: clean context, agent brightens, breathe back to normal speed
        .to(".ot-agent", { opacity: 1, duration: 0.5, onStart: () => br.timeScale(1) }, "+=0.3")
      comeOnline(tl, ".ot-dot", 112, 71, "<")
      tl.to({}, { duration: 1.0 })
    },
    { scope: ref }
  )

  return (
    <svg ref={ref} viewBox="0 0 200 130" className="ot-svg h-full w-full">
      <TileDefs idPrefix={idPrefix} />
      <circle cx="100" cy="60" r="30" fill="none" stroke="var(--muted)" strokeWidth="5" />
      <circle
        className="ot-ring"
        cx="100"
        cy="60"
        r="30"
        fill="none"
        stroke="var(--status-online)"
        strokeWidth="5"
        strokeLinecap="round"
        transform="rotate(-90 100 60)"
        strokeDasharray="188.5"
        strokeDashoffset="188.5"
      />
      <g className="ot-agent ot-center">
        <svg x="83" y="43" width="34" height="34" viewBox="0 0 36 36">
          <g clipPath={`url(#${id.disc})`}>
            <use href={`#${id.faceA}`} />
          </g>
        </svg>
      </g>
      <g className="ot-online">
        <circle cx="112" cy="71" r="6" fill="var(--card)" />
        <circle cx="112" cy="71" r="4" fill="var(--muted-foreground)" />
        <circle className="ot-dot" cx="112" cy="71" r="4" fill="var(--status-online)" />
      </g>
      <text className="ot-pct" x="100" y="106" textAnchor="middle" fontFamily="DM Mono, monospace" fontSize="10" fill="var(--muted-foreground)">
        context 0%
      </text>
      <g className="ot-sleep ot-accent ot-center" opacity="0">
        <svg x="140" y="30" width="20" height="20" viewBox="0 0 24 24">
          <use href={`#${id.moon}`} />
        </svg>
        <text x="163" y="40" fontFamily="DM Mono, monospace" fontSize="12" fill="currentColor">z</text>
        <text x="172" y="32" fontFamily="DM Mono, monospace" fontSize="8" fill="currentColor">z</text>
      </g>
    </svg>
  )
}
