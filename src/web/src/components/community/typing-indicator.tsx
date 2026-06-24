// Typing indicator — bouncing dots + "{names} is/are typing…".
export function TypingIndicator({ names }: { names: string[] }) {
  if (!names.length) return null
  const label = names.length === 1
    ? <><span className="font-medium text-foreground">{names[0]}</span> is typing…</>
    : names.length <= 3
      ? <><span className="font-medium text-foreground">{names.slice(0, -1).join(", ")} and {names[names.length - 1]}</span> are typing…</>
      : <><span className="font-medium text-foreground">{names.length} people</span> are typing…</>
  return (
    <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </span>
      <span>{label}</span>
    </div>
  )
}
