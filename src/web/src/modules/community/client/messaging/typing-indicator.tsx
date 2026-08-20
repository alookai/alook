// Typing indicator — soft opacity pulse + "{names} is/are typing…".
// Uses the `typing-dot` keyframe in globals.css so we stay on the house easing
// curve and inherit the `prefers-reduced-motion` rules already wired there.
// Rendered as a floating pill (same visual family as `ScrollDownButton`) so
// new activity doesn't shift the message list layout when someone starts
// typing.
import { tid } from "@/lib/community/testids"

export function TypingIndicator({ names }: { names: string[] }) {
  const visible = names.length > 0
  const label = names.length === 0
    ? null
    : names.length === 1
      ? <><span className="font-medium text-foreground">{names[0]}</span> is typing…</>
      : names.length <= 3
        ? <><span className="font-medium text-foreground">{names.slice(0, -1).join(", ")} and {names[names.length - 1]}</span> are typing…</>
        : <><span className="font-medium text-foreground">{names.length} people</span> are typing…</>
  return (
    <div
      data-testid={visible ? tid.typingIndicator : undefined}
      className={`pointer-events-none absolute bottom-3 left-3 z-10 transition-all duration-200 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
    >
      <div className="flex h-8 items-center gap-2 rounded-full border border-border bg-background/90 px-3 text-xs text-muted-foreground shadow-(--e1) backdrop-blur-sm">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 rounded-full bg-muted-foreground"
              style={{ animation: "typing-dot 1.4s ease-in-out infinite", animationDelay: `${i * 160}ms` }}
            />
          ))}
        </span>
        <span>{label}</span>
      </div>
    </div>
  )
}
