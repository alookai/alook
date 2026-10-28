"use client"

import type { ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { GradientBackground } from "@/components/gradient-background"
import { Logo } from "@/components/logo"
import { LandingShellMotion } from "@/components/home/landing-shell-motion"
import type { LandingScene } from "@/components/home/landing-shell-motion-timeline"
import galleryStyles from "@/components/home/landing-shell-motion.module.css"
import { cn } from "@/lib/utils"

export const galleryScenes: { scene: LandingScene; label: string; description: string }[] = [
  {
    scene: "server",
    label: "The best room for agents and humans",
    description: "Bring your people and agents together in one shared home.",
  },
  {
    scene: "spaces",
    label: "A room for every part of life",
    description: "Keep work, life, and play separate—invite the friends and bots who belong.",
  },
  {
    scene: "machine",
    label: "Bring your own agents",
    description: "Use your own computer and existing agent subscriptions.",
  },
  {
    scene: "provider",
    label: "Persistent identity and memory",
    description: "Your agents stay themselves, independent of provider.",
  },
]

export function SignInGallery({ active = 0, onSelect, beat }: { active?: number; onSelect?: (index: number) => void; beat?: number }) {
  const activeScene = galleryScenes[active]
  return (
    <div className={`${galleryStyles.galleryContainer} flex h-full min-h-0 flex-col items-center justify-center p-5 lg:p-7`}>
      <div
        className={`${galleryStyles.galleryFrame} w-full bg-background ring-1 ring-border/60 shadow-lg`}
        role="img"
        aria-label={activeScene.label}
      >
        <LandingShellMotion
          key={activeScene.scene}
          scene={activeScene.scene}
          beat={beat}
        />
      </div>
      <div className={`${galleryStyles.galleryFooter} mt-4`}>
        <div aria-live="polite">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {String(active + 1).padStart(2, "0")} / {String(galleryScenes.length).padStart(2, "0")}
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {activeScene.label}
          </p>
          <p className="mt-0.5 max-w-lg text-xs leading-relaxed text-muted-foreground">
            {activeScene.description}
          </p>
        </div>
        <div className={galleryStyles.gallerySwitcher} aria-label="Product stories">
          {galleryScenes.map((item, i) => (
            <button
              key={item.scene}
              onClick={() => onSelect?.(i)}
              className="grid size-8 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Show ${item.label}`}
              aria-pressed={i === active}
            >
              <span
                className="h-1.5 rounded-full transition-all duration-300"
                style={{
                  width: i === active ? 16 : 6,
                  backgroundColor: i === active
                    ? "var(--foreground)"
                    : "var(--muted-foreground)",
                  opacity: i === active ? 1 : 0.3,
                }}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function SignInHeading({ subtitle, headingAs: Heading = "h1" }: { subtitle?: string; headingAs?: "h1" | "div" }) {
  return (
      <div className="flex flex-col items-center gap-2 text-center">
        <Heading className="text-2xl font-bold">Sign in</Heading>
        <p className="text-sm text-muted-foreground">or create an account to get started</p>
        {subtitle && (
          <p className="text-balance text-muted-foreground">{subtitle}</p>
        )}
      </div>
  )
}

export function SignInLayout({ children, gallery, className, embedded = false }: { children: ReactNode; gallery: ReactNode; className?: string; embedded?: boolean }) {
  return (
    <div className={cn("relative flex min-h-svh flex-col items-center justify-center p-6 sm:p-10", className)}>
      <GradientBackground className={embedded ? "absolute" : undefined} />
      <div className="w-full max-w-sm sm:max-w-6xl">
        <div className="flex flex-col gap-6">
          <div className="flex justify-center mb-2">
            <Logo size="lg" />
          </div>
          <Card className="overflow-hidden p-0">
            <CardContent className="grid p-0 sm:grid-cols-[minmax(320px,0.82fr)_minmax(0,1.35fr)]">
              <div className="flex flex-col justify-center p-6 sm:min-h-120 sm:p-8">
                {children}
              </div>
              <div className="relative hidden min-h-120 overflow-hidden bg-muted sm:block">
                {gallery}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
