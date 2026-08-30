import { Maximize2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"

export function ThreadPanelActions({
  onFullscreen,
  onClose,
}: {
  onFullscreen: () => void
  onClose: () => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-l border-border/60 pl-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid={tid.threadSplitFullscreen}
        onClick={onFullscreen}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Open thread full screen"
        title="Open full screen"
      >
        <Maximize2 className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid={tid.threadSplitClose}
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Close thread"
        title="Close thread"
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}
