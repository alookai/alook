import { cn } from "@/lib/utils"

export function ChannelIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="7 0 14 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("h-[1em] w-auto shrink-0", className)}
    >
      <line x1="18" y1="4" x2="10" y2="20" />
    </svg>
  )
}
