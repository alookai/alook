// Left rail indicator — 3 states: active (40px), hover (20px), default (hidden).
// Parent must be `group relative`.
export function RailIndicator({ active }: { active?: boolean }) {
  return (
    <span
      className={[
        "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all duration-150",
        active ? "h-10" : "h-0 group-hover:h-5",
      ].join(" ")}
    />
  )
}
