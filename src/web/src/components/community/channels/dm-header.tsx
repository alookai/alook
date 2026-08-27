import { Bell, BellOff, Check, ChevronLeft } from "lucide-react"
import { NOTIF_LEVELS, type NotifLevel } from "@alook/shared"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "../avatar"
import type { DM } from "@/lib/community/models/people"
import { tid } from "@/lib/community/testids"

export function DmHeader({ dm, onBack, titleAs: Title = "h1", notifLevel, onSetNotifLevel }: {
  dm: DM
  onBack?: () => void
  titleAs?: "h1" | "div"
  notifLevel?: NotifLevel
  onSetNotifLevel?: (level: NotifLevel) => void
}) {
  return (
    <header data-testid={tid.dmHeader} className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      <Avatar label={dm.avatar} seed={dm.userId} size={24} presence={dm.status} />
      <Title data-testid={tid.dmHeaderTitle} className="min-w-0 truncate font-heading text-base font-medium leading-[1.15] tracking-[-0.015em]">
        {dm.name}
        {dm.discriminator && (
          <span className="ml-1 text-xs font-normal tracking-wide text-muted-foreground">
            #{dm.discriminator}
          </span>
        )}
      </Title>
      {notifLevel && <DmNotifDropdown level={notifLevel} onSetLevel={onSetNotifLevel} />}
    </header>
  )
}

function DmNotifDropdown({ level, onSetLevel }: { level: NotifLevel; onSetLevel?: (level: NotifLevel) => void }) {
  const muted = level === "Nothing"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button variant="ghost" size="icon-sm" className={`ml-auto ${muted ? "text-destructive" : "text-muted-foreground"}`} aria-label="Direct message notifications" />
      }>
        {muted ? <BellOff className="size-4" /> : <Bell className="size-4" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {NOTIF_LEVELS.map((option) => (
          <DropdownMenuItem key={option.value} onClick={() => onSetLevel?.(option.display)}>
            <span className="min-w-0 flex-1">{option.label}</span>
            {level === option.display && <Check className="size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
        <div className="px-2 py-1.5 text-xs text-muted-foreground">Changes clear existing unread in this conversation.</div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Loading placeholder for <DmHeader> — same h-12 footprint so the body below
// stays anchored across the route change.
export function DmHeaderSkeleton({ onBack }: { onBack?: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3">
      {onBack && (
        <Skeleton data-slot="loading-back-placeholder" aria-hidden className="size-8 shrink-0 rounded-md" />
      )}
      <Skeleton className="size-6 rounded-full" />
      <Skeleton className="h-4 w-32 rounded" />
      <Skeleton className="ml-auto size-7 rounded-md" />
    </header>
  )
}
