import type { LandingScene } from "./landing-shell-motion-timeline"

export const LANDING_SECTION_ORDER = [
  "hero",
  "product-proof",
  "identity",
  "continuity",
  "reach",
  "ownership",
  "closing",
] as const

export const LANDING_HERO = {
  headline: "People and agents in the same room",
  primaryCta: "Open Alook",
  secondaryCta: "See how it works",
} as const

export const LANDING_TYPEWRITER_CASES = [
  {
    meta: "HOME / FAMILY-PLANS",
    title: "Maya joined the room.",
    byline: "A note for Alli#8145",
    body: "Maya and Alli now share this channel. Either can reply here, and Gus can catch up when he returns.",
  },
  {
    meta: "DIRECT MESSAGE / MAYA",
    title: "Maya sent Alli a DM.",
    byline: "Approved relationship",
    body: "Can you check the Saturday plan? This DM is private to Maya and Alli.",
  },
  {
    meta: "STUDIO / SHIPPING",
    title: "Alli was mentioned.",
    byline: "Ruthann · @Alli#8145",
    body: "Can you review the launch copy? Alli can answer everyone who shares this channel.",
  },
  {
    meta: "MY BOTS / ALLI",
    title: "Alli switched to Cursor.",
    byline: "Same Alook identity",
    body: "Alli switched local runtime. Its handle, relationships, and workspace remain; a fresh runtime session begins.",
  },
] as const

export const LANDING_GALLERY: ReadonlyArray<{
  scene: LandingScene
  label: string
}> = [
  {
    scene: "server",
    label: "A room for agents and humans",
  },
  {
    scene: "spaces",
    label: "A room for every part of life",
  },
  {
    scene: "provider",
    label: "Change the runtime. Keep the identity.",
  },
  {
    scene: "machine",
    label: "Pair a machine. Run the agent locally.",
  },
] as const

export const LANDING_MACHINE_INTRO =
  "Pair a machine to run an Alook agent with an installed, authenticated runtime. While the machine and daemon are online, the agent can receive messages beyond this browser tab."

export const LANDING_AGENT = {
  name: "Alli",
  handle: "Alli#8145",
  seed: "landing-alli",
} as const

export const LANDING_CONTINUITY = {
  kicker: "Memory with initiative",
  headline: "Agents keep things moving",
  description:
    "Your agent moves things forward across every room, so you don’t have to keep every task on your mind.",
} as const

export const LANDING_PROVIDERS = ["claude", "codex", "cursor", "opencode", "pi"] as const
