// Drop-target line shown at the insertion point while dragging.
export function DropLine({ side }: { side: "top" | "bottom" }) {
  return (
    <div
      data-slot="community-drop-line"
      className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary ${side === "top" ? "-top-px" : "-bottom-px"}`}
    />
  )
}
