import type { MouseEventHandler } from "react"
import { LoaderCircle } from "@/components/icons/lucide"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SendStrokeRoundedIcon } from "./send-stroke-rounded-icon"

export function ComposerSendButton({
  type = "button",
  testId,
  ariaLabel = "Send message",
  disabled = false,
  sending = false,
  className,
  onClick,
}: {
  type?: "button" | "submit"
  testId?: string
  ariaLabel?: string
  disabled?: boolean
  sending?: boolean
  className?: string
  onClick?: MouseEventHandler<HTMLButtonElement>
}) {
  return (
    <Button
      type={type}
      size="icon"
      data-testid={testId}
      className={cn(
        "community-composer-send absolute right-2 bottom-2 size-8 rounded-full",
        className,
      )}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
    >
      {sending
        ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
        : <SendStrokeRoundedIcon className="size-5 -translate-x-px translate-y-px" />}
    </Button>
  )
}
