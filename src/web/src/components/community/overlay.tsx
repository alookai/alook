import type React from "react"

// Scrim overlay (tablet) — dims the shell and slides a panel in from the left or right.
// Tapping the scrim closes it; taps inside the panel are stopped.
export function Overlay({ children, onClose, side }: {
  children: React.ReactNode
  onClose: () => void
  side: "left" | "right"
}) {
  return (
    <div className="absolute inset-0 z-20 flex" onClick={onClose}>
      <div className="absolute inset-0 bg-foreground/20" />
      <div className={`relative h-full ${side === "right" ? "ml-auto" : ""}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
