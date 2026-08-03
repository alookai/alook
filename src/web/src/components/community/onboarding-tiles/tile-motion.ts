import gsap from "gsap"

// Shared motion helpers ported from the design prototype. All selectors are
// resolved within a per-tile scope (useGSAP({ scope: ref })), so class-based
// selectors like ".ot-dot" are safe even when several tiles mount at once.

export const OT_EASE = "sine.inOut"

// Gentle idle "breathing" of the agent avatar. Returns the tween so callers can
// vary its timeScale (Nap slows it as context fills).
export function breathe(scope: Element, sel: string, amt = 1.02, dur = 3) {
  return gsap.to(scope.querySelectorAll(sel), {
    scale: amt,
    duration: dur,
    ease: OT_EASE,
    yoyo: true,
    repeat: -1,
    transformOrigin: "center",
  })
}

// Presence flip — the online dot goes online/offline IN PLACE (fixed geometry):
// a small scale pulse about the dot's own center + a DISCRETE color swap (the
// green layer toggles instantly at the pulse peak, so there is no muddy
// in-between color). ox/oy = the dot's exact center in SVG units.
export function comeOnline(tl: gsap.core.Timeline, sel: string, ox: number, oy: number, pos?: gsap.Position) {
  tl.set(sel, { opacity: 1 }, pos)
    .to(sel, { scale: 1.35, duration: 0.18, ease: "power2.out", svgOrigin: `${ox} ${oy}` }, pos)
    .to(sel, { scale: 1, duration: 0.28, ease: "power2.inOut", svgOrigin: `${ox} ${oy}` })
}

export function goOffline(tl: gsap.core.Timeline, sel: string, ox: number, oy: number, pos?: gsap.Position) {
  tl.to(sel, { scale: 0.82, duration: 0.16, ease: "power2.out", svgOrigin: `${ox} ${oy}` }, pos)
    .set(sel, { opacity: 0 })
    .to(sel, { scale: 1, duration: 0.2, ease: "power2.inOut", svgOrigin: `${ox} ${oy}` })
}
