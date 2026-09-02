import type { ReactNode } from "react"
import { ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function MessageHeader({
  testId,
  leading,
  identity,
  actions,
  identityClassName,
}: {
  testId?: string
  leading?: ReactNode
  identity: ReactNode
  actions?: ReactNode
  identityClassName?: string
}) {
  return (
    <header
      role="banner"
      data-testid={testId}
      className="flex h-12 shrink-0 items-center gap-1 border-b border-border/40 px-3"
    >
      {leading}
      <div
        data-slot="message-header-identity"
        className={cn("flex min-w-0 items-center gap-1", identityClassName)}
      >
        {identity}
      </div>
      <div
        data-slot="message-header-actions"
        className="ml-auto flex shrink-0 items-center text-muted-foreground"
      >
        {actions}
      </div>
    </header>
  )
}

export function MessageHeaderMobileBack({ onNavigate, label = "Back" }: {
  onNavigate: () => void
  label?: string
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onNavigate}
      className="size-11 shrink-0 text-muted-foreground hover:text-foreground sm:hidden"
      aria-label={label}
    >
      <ChevronLeft className="size-5" />
    </Button>
  )
}
