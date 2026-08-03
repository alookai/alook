"use client"

import { useRef } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { TileDefs, tileIds } from "./tile-defs"
import { OT_EASE, breathe, comeOnline, goOffline } from "./tile-motion"

// "Memory" — the agent's memory sources ORBIT around it (they belong to it &
// persist). Each rides a ring, PAUSES at the top to reveal its label (memory.md /
// experiences / timeline), then shrinks to an icon as it rotates on. On reset the
// live self dims but the orbit keeps turning; on wake the agent relights.
export function MemoryTile({ idPrefix = "ot-memory" }: { idPrefix?: string }) {
  const ref = useRef<SVGSVGElement>(null)
  const id = tileIds(idPrefix)

  useGSAP(
    () => {
      const scope = ref.current
      if (!scope) return
      const CX = 100, CY = 62, R = 40
      const TOP = -90
      const srcs = [".ot-src0", ".ot-src1", ".ot-src2"].map((sel, i) => {
        const g = scope.querySelector(sel) as SVGGElement
        return {
          g,
          lbl: g.querySelector(".ot-lbl") as SVGTextElement,
          base: TOP + i * 120,
        }
      })
      const place = (s: (typeof srcs)[number], deg: number) => {
        const a = (deg * Math.PI) / 180
        const x = CX + R * Math.cos(a)
        const y = CY + R * Math.sin(a)
        const d = (((deg - TOP) % 360) + 540) % 360 - 180
        const near = Math.max(0, 1 - Math.abs(d) / 60)
        s.g.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`)
        s.g.style.opacity = (0.5 + 0.5 * near).toFixed(3)
      }
      const spin = { a: 0 }
      gsap.set(".ot-dot", { opacity: 1 })
      gsap.set(".ot-lbl", { opacity: 0 })
      srcs.forEach((s) => place(s, s.base))
      breathe(scope, ".ot-agent", 1.02, 3.4)

      // step orbit: reveal top label → dwell → hide → rotate 120° → reveal new top
      const orbit = gsap.timeline({ repeat: -1 })
      for (let k = 0; k < 3; k++) {
        const cur = srcs[(((-k % 3) + 3) % 3)]
        orbit
          .to(cur.lbl, { opacity: 1, duration: 0.3 })
          .to({}, { duration: 0.6 })
          .to(cur.lbl, { opacity: 0, duration: 0.25 })
          .to(spin, {
            a: "+=120",
            duration: 0.85,
            ease: "power2.inOut",
            onUpdate: () => srcs.forEach((s) => place(s, s.base + spin.a)),
          })
      }

      // reset/wake on the live self only — the orbit never stops
      const tl = gsap.timeline({ repeat: -1, defaults: { ease: OT_EASE } })
      tl.to({}, { duration: 3 }).to(".ot-agent", { opacity: 0.3, duration: 0.5 })
      goOffline(tl, ".ot-dot", 112, 73, "<")
      tl.to({}, { duration: 1.1 }).to(".ot-agent", { opacity: 1, duration: 0.5 })
      comeOnline(tl, ".ot-dot", 112, 73, "<")
      tl.to({}, { duration: 1.5 })
    },
    { scope: ref }
  )

  const srcData = [
    { cls: "ot-src0", icon: id.book, label: "memory.md" },
    { cls: "ot-src1", icon: id.layers, label: "experiences" },
    { cls: "ot-src2", icon: id.clock, label: "timeline" },
  ]

  return (
    <svg ref={ref} viewBox="0 0 200 130" className="ot-svg h-full w-full">
      <TileDefs idPrefix={idPrefix} />
      <circle cx="100" cy="62" r="40" className="ot-art" opacity="0.14" strokeDasharray="2 5" />
      <g className="ot-agent ot-center">
        <svg x="83" y="45" width="34" height="34" viewBox="0 0 36 36">
          <g clipPath={`url(#${id.disc})`}>
            <use href={`#${id.faceA}`} />
          </g>
        </svg>
      </g>
      <g className="ot-online">
        <circle cx="112" cy="73" r="6" fill="var(--card)" />
        <circle cx="112" cy="73" r="4" fill="var(--muted-foreground)" />
        <circle className="ot-dot" cx="112" cy="73" r="4" fill="var(--status-online)" />
      </g>
      {srcData.map((s) => (
        <g key={s.cls} className={`ot-src ${s.cls}`}>
          <circle className="ot-pill" cx="0" cy="0" r="12" fill="var(--muted)" />
          <svg className="ot-ic ot-accent" x="-8" y="-8" width="16" height="16" viewBox="0 0 24 24">
            <use href={`#${s.icon}`} />
          </svg>
          <text className="ot-lbl" x="16" y="4" textAnchor="start" fontFamily="DM Mono, monospace" fontSize="8.5" fill="var(--foreground)" opacity="0">
            {s.label}
          </text>
        </g>
      ))}
    </svg>
  )
}
