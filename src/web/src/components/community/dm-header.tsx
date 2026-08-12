import { ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import type { DM } from "./_types"

export function DmHeader({ dm, onBack, titleAs: Title = "h1" }: {
  dm: DM
  onBack?: () => void
  titleAs?: "h1" | "div"
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      <Avatar label={dm.avatar} seed={dm.userId} size={24} presence={dm.status} />
      <Title className="min-w-0 truncate font-heading text-base font-medium leading-[1.15] tracking-[-0.015em]">
        {dm.name}
        {dm.discriminator && (
          <span className="ml-1 text-xs font-normal tracking-wide text-muted-foreground">
            #{dm.discriminator}
          </span>
        )}
      </Title>
    </header>
  )
}

// Loading placeholder for <DmHeader> — same h-12 footprint so the body below
// stays anchored across the route change.
export function DmHeaderSkeleton({ onBack }: { onBack?: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      <Skeleton className="size-6 rounded-full" />
      <Skeleton className="h-4 w-32 rounded" />
    </header>
  )
}
