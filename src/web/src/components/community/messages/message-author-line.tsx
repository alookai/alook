import type { ComponentPropsWithoutRef, CSSProperties, MouseEventHandler, ReactNode } from "react"
import { cn } from "@/lib/utils"

type TimestampProps = Omit<ComponentPropsWithoutRef<"time">, "children" | "className"> & {
  [attribute: `data-${string}`]: string | number | boolean | undefined
}

type MessageAuthorLineProps = {
  authorName: string
  timestamp?: ReactNode
  timestampProps?: TimestampProps
  onAuthorClick?: MouseEventHandler<HTMLButtonElement>
  color?: CSSProperties["color"]
  variant?: "message" | "compact" | "note"
  className?: string
}

const typography = {
  message: {
    author: "text-[15px] font-semibold",
    timestamp: "text-xs text-muted-foreground",
  },
  compact: {
    author: "text-sm font-medium",
    timestamp: "text-xs text-muted-foreground",
  },
  note: {
    author: "font-semibold",
    timestamp: "font-mono text-[9px] tabular-nums text-(--note-muted)",
  },
}

export function MessageAuthorLine({
  authorName,
  timestamp,
  timestampProps,
  onAuthorClick,
  color,
  variant = "message",
  className,
}: MessageAuthorLineProps) {
  const authorClassName = cn("min-w-0 max-w-full truncate", typography[variant].author)
  return (
    <div
      data-message-author-line
      className={cn(
        "flex min-w-0 max-w-full items-baseline gap-2",
        variant === "note" && "w-fit items-center text-xs leading-4",
        className,
      )}
    >
      {onAuthorClick ? (
        <button
          type="button"
          onClick={onAuthorClick}
          title={authorName}
          className={cn(authorClassName, "hover:underline")}
          style={{ color }}
        >
          {authorName}
        </button>
      ) : (
        <span title={authorName} className={authorClassName} style={{ color }}>
          {authorName}
        </span>
      )}
      {timestamp != null && (
        <time
          {...timestampProps}
          className={cn("shrink-0 whitespace-nowrap", typography[variant].timestamp)}
          suppressHydrationWarning
        >
          {timestamp}
        </time>
      )}
    </div>
  )
}
