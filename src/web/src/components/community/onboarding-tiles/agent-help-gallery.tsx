"use client"

import { useState } from "react"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { MemoryTile } from "./memory-tile"
import { WorkspaceTile } from "./workspace-tile"
import { NapTile } from "./nap-tile"

// "How your agent works" — a help gallery of the agent mechanics that don't get
// their own empty state (Memory / Local workspace / Nap). One explainer per view,
// stepped left/right (Gus's call: not all at once). Opened from the ? in the My
// Bots header. Each slide mounts its own animated tile only while visible, so the
// GSAP timelines don't run for hidden slides.
const SLIDES = [
  {
    key: "memory",
    title: "Memory",
    tile: MemoryTile,
    body: "Your agent has a built-in memory: it writes to memory.md, experiences, and a timeline. These survive a reset and load back on wake.",
  },
  {
    key: "workspace",
    title: "Local workspace",
    tile: WorkspaceTile,
    body: "Each agent gets a private folder on your machine. Its files — and the runtime itself — stay local; nothing is uploaded.",
  },
  {
    key: "nap",
    title: "Nap",
    tile: NapTile,
    body: "With time and work, your agent piles up context from every turn. Tell it to \"nap\" to clear that short-term context and start fresh — it leaves a handoff note first.",
  },
] as const

export function AgentHelpGallery({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [i, setI] = useState(0)
  const slide = SLIDES[i]
  const Tile = slide.tile
  const go = (dir: 1 | -1) => setI((n) => (n + dir + SLIDES.length) % SLIDES.length)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex w-full max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogTitle className="text-base font-medium">How your agent works</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              A few mechanics worth knowing about the agents you own.
            </DialogDescription>
          </div>
          <DialogClose
            render={
              <Button variant="ghost" size="icon-sm" aria-label="Close" className="-mr-1 shrink-0 text-muted-foreground hover:text-foreground" />
            }
          >
            <X className="size-4" />
          </DialogClose>
        </header>

        <div className="flex flex-col gap-3 px-5 pb-5">
          {/* the animated explainer for the current slide. No border here: the
              Workspace tile draws its own pane frame, so a wrapper border would
              double up — a soft fill gives containment without a second stroke. */}
          <div className="overflow-hidden rounded-xl bg-muted/40">
            <div className="aspect-200/130 w-full">
              {/* key remounts the tile per slide so its GSAP timeline restarts */}
              <Tile key={slide.key} />
            </div>
          </div>
          {/* fixed height so the dialog doesn't wobble as slides swap (bodies
              differ in length); sized to the tallest copy. */}
          <div className="flex h-28 flex-col gap-1 text-center">
            <h3 className="text-sm font-medium text-foreground">{slide.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{slide.body}</p>
          </div>

          {/* stepper: prev · dots · next */}
          <div className="mt-1 flex items-center justify-between">
            <Button variant="ghost" size="icon-sm" aria-label="Previous" onClick={() => go(-1)} className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="size-5" />
            </Button>
            <div className="flex items-center gap-1.5">
              {SLIDES.map((s, n) => (
                <button
                  key={s.key}
                  type="button"
                  aria-label={`Go to ${s.title}`}
                  aria-current={n === i}
                  onClick={() => setI(n)}
                  className={
                    "size-1.5 rounded-full transition-colors " +
                    (n === i ? "bg-foreground" : "bg-border hover:bg-muted-foreground")
                  }
                />
              ))}
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Next" onClick={() => go(1)} className="text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-5" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
