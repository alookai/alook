"use client"

import { useRef } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { TileDefs, tileIds } from "./tile-defs"
import { OT_EASE } from "./tile-motion"

// "Local workspace" — the owning agent sits in the path title-bar (~/.alook/agent);
// named files (memory.md / work.pdf / todo.md) are written into the dir one by
// one, rest populated, then clear for the loop. No moving cursor.
export function WorkspaceTile({ idPrefix = "ot-workspace" }: { idPrefix?: string }) {
  const ref = useRef<SVGSVGElement>(null)
  const id = tileIds(idPrefix)

  useGSAP(
    () => {
      const scope = ref.current
      if (!scope) return
      const files = [".ot-f0", ".ot-f1", ".ot-f2"]
      gsap.set(files, { opacity: 0 })
      const tl = gsap.timeline({ repeat: -1, defaults: { ease: OT_EASE } })
      files.forEach((f, i) => {
        tl.fromTo(f, { opacity: 0 }, { opacity: 1, duration: 0.5 }, i === 0 ? ">" : "+=0.5")
      })
      tl.to({}, { duration: 1.7 })
        .to(files, { opacity: 0, duration: 0.5, stagger: 0.08 })
        .to({}, { duration: 0.5 })
    },
    { scope: ref }
  )

  const files = [
    { cls: "ot-f0", ty: "65.5", name: "memory.md" },
    { cls: "ot-f1", ty: "83.5", name: "work.pdf" },
    { cls: "ot-f2", ty: "101.5", name: "todo.md" },
  ]

  return (
    <svg ref={ref} viewBox="0 0 200 130" className="ot-svg h-full w-full">
      <TileDefs idPrefix={idPrefix} />
      <rect className="ot-art" x="20" y="20" width="160" height="100" rx="9" opacity="0.9" />
      {/* title bar: [agent avatar] ~/.alook/agent — avatar (22px) & file icons (11px) share center-x=40 */}
      <svg x="29" y="30" width="22" height="22" viewBox="0 0 36 36">
        <g clipPath={`url(#${id.disc})`}>
          <use href={`#${id.faceA}`} />
        </g>
      </svg>
      <g className="ot-oon">
        <circle cx="48" cy="49" r="4" fill="var(--card)" />
        <circle cx="48" cy="49" r="2.5" fill="var(--status-online)" />
      </g>
      <text x="60" y="45" fontFamily="DM Mono, monospace" fontSize="10" fill="var(--foreground)">~/.alook/agent</text>
      <line className="ot-art" x1="20" y1="58" x2="180" y2="58" opacity="0.35" />
      {files.map((f) => (
        <g key={f.cls} className={`ot-wfile ${f.cls}`} transform={`translate(34.5 ${f.ty})`}>
          <svg x="0" y="0" width="11" height="11" viewBox="0 0 24 24" className="ot-accent">
            <use href={`#${id.file}`} />
          </svg>
          <text x="17" y="9.5" fontFamily="DM Mono, monospace" fontSize="10" fill="var(--foreground)">
            {f.name}
          </text>
        </g>
      ))}
    </svg>
  )
}
