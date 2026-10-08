"use client"

import { useId, useRef } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { FolderLock, MessageSquare } from "lucide-react"
import { TileDefs, tileIds } from "../onboarding-tiles/tile-defs"
import { OT_EASE, comeOnline } from "../onboarding-tiles/tile-motion"

export function MachinePairMessageDiagram() {
  const scope = useRef<SVGSVGElement>(null)
  const idPrefix = useId()
  const id = tileIds(idPrefix)

  useGSAP(() => {
    const media = gsap.matchMedia()
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const timeline = gsap.timeline({ repeat: -1, repeatDelay: 1.2, defaults: { ease: OT_EASE } })
      timeline.set(".pair-packet", { x: 312, y: 60, opacity: 0 })
        .to(".pair-packet", { opacity: 1, duration: 0.2 })
        .to(".pair-packet", { x: 104, duration: 1.2, ease: "power1.inOut" })
        .to(".pair-packet", { opacity: 0, duration: 0.15 })
      comeOnline(timeline, ".pair-online", 117, 73)
      timeline.to({}, { duration: 0.6 })
        .set(".pair-packet", { x: 104 })
        .to(".pair-packet", { opacity: 1, duration: 0.2 })
        .to(".pair-packet", { x: 312, duration: 1.2, ease: "power1.inOut" })
        .to(".pair-packet", { opacity: 0, duration: 0.15 })
        .set(".pair-arrival", { attr: { r: 18 }, opacity: 0.65 })
        .to(".pair-arrival", { attr: { r: 28 }, opacity: 0, duration: 0.6, ease: "power2.out" })
      const updateVisibility = () => { timeline.paused(document.hidden) }
      updateVisibility()
      document.addEventListener("visibilitychange", updateVisibility)
      return () => { document.removeEventListener("visibilitychange", updateVisibility) }
    })
    return () => media.revert()
  }, { scope })

  return (
    <figure className="rounded-lg bg-muted/50 p-4">
      <svg
        ref={scope}
        viewBox="0 0 360 184"
        role="img"
        aria-label="Your CLI agent and local files stay on your computer. Messages and replies travel between the agent and Alook. Alook does not automatically upload local file contents."
        className="ot-svg w-full font-sans"
      >
        <TileDefs idPrefix={idPrefix} />
        <rect x="12" y="24" width="184" height="128" rx="10" fill="var(--card)" stroke="currentColor" strokeWidth="1.5" />
        <rect x="18" y="30" width="172" height="108" rx="5" fill="var(--popover)" stroke="currentColor" strokeWidth="0.75" strokeOpacity="0.25" />
        <circle cx="104" cy="145" r="1.5" fill="currentColor" opacity="0.5" />
        <path d="M100 152H108L110 159H98Z" fill="currentColor" opacity="0.75" />
        <rect x="80" y="158" width="48" height="5" rx="2.5" fill="currentColor" opacity="0.75" />
        <path d="M130 60H284" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.28" />
        <circle cx="196" cy="60" r="3" fill="var(--card)" stroke="currentColor" strokeWidth="1.5" />
        <text x="248" y="40" textAnchor="middle" fontSize="12" fill="var(--muted-foreground)">Only messages</text>
        <g className="pair-agent">
          <svg x="88" y="44" width="32" height="32" viewBox="0 0 36 36">
            <g clipPath={`url(#${id.disc})`}>
              <use href={`#${id.faceA}`} />
            </g>
          </svg>
          <circle cx="117" cy="73" r="5.5" fill="var(--muted)" />
          <circle className="pair-online" cx="117" cy="73" r="3.5" fill="var(--status-online)" />
        </g>
        <FolderLock className="pair-files" x="88" y="86" width="32" height="26" strokeWidth="1.5" />
        <text x="104" y="126" textAnchor="middle" fontSize="11" fill="var(--muted-foreground)">Local files · no auto-upload</text>
        <image href="/alook.svg" x="296" y="44" width="32" height="32" />
        <circle cx="312" cy="60" className="pair-arrival" r="18" fill="none" stroke="var(--status-online)" strokeWidth="1.5" opacity="0" />
        <g className="pair-packet" opacity="0">
          <MessageSquare x="-9" y="-7" width="18" height="14" stroke="var(--status-online)" strokeWidth="1.5" fill="var(--muted)" />
        </g>
      </svg>
    </figure>
  )
}
