import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"

export function TypingIndicator({ names, className }: { names: string[]; className?: string }) {
  if (names.length === 0) return null
  const label = names.length === 0
    ? null
    : names.length === 1
      ? <><span className="font-medium text-foreground">{names[0]}</span> is typing…</>
      : names.length <= 3
        ? <><span className="font-medium text-foreground">{names.slice(0, -1).join(", ")} and {names[names.length - 1]}</span> are typing…</>
        : <><span className="font-medium text-foreground">{names.length} people</span> are typing…</>
  return (
    <div
      data-testid={tid.typingIndicator}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        "pointer-events-none flex h-8 min-w-0 max-w-full items-center gap-2 rounded-full border border-border bg-background/90 px-3 text-xs text-muted-foreground shadow-(--e1) backdrop-blur-sm",
        className,
      )}
    >
      <span className="flex shrink-0 gap-1">
        <span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-[typing-dot_1.4s_ease-in-out_infinite]" />
        <span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-[typing-dot_1.4s_ease-in-out_160ms_infinite]" />
        <span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-[typing-dot_1.4s_ease-in-out_320ms_infinite]" />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </div>
  )
}
