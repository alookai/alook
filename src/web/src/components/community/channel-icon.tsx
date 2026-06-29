import { cn } from "@/lib/utils"

// The "/" text-channel glyph, drawn as a stroked icon so its weight and baseline
// match the lucide icons it sits beside (e.g. the forum MessagesSquare). Sized in
// `em` so the existing `text-*` classes at call sites keep controlling its size.
export function ChannelIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("size-[1em] shrink-0", className)}
    >
      <line x1="16" y1="4" x2="8" y2="20" />
    </svg>
  )
}
