import { Bell, BellOff, Check } from "lucide-react"
import { NOTIF_LEVELS, type NotifLevel } from "@alook/shared"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "../avatar"
import type { DM } from "@/lib/community/models/people"
import { tid } from "@/lib/community/testids"
import { MessageHeader, MessageHeaderMobileBack } from "./message-header"

export function DmHeader({ dm, onBack, titleAs: Title = "h1", notifLevel, onSetNotifLevel }: {
  dm: DM
  onBack?: () => void
  titleAs?: "h1" | "div"
  notifLevel?: NotifLevel
  onSetNotifLevel?: (level: NotifLevel) => void
}) {
  return (
    <MessageHeader
      testId={tid.dmHeader}
      leading={onBack ? <MessageHeaderMobileBack onNavigate={onBack} /> : undefined}
      identityClassName="gap-2"
      identity={(
        <>
          <Avatar label={dm.avatar} seed={dm.userId} size={24} presence={dm.status} />
          <Title data-testid={tid.dmHeaderTitle} className="min-w-0 truncate font-heading text-base font-medium leading-[1.15] tracking-[-0.015em]">
            {dm.name}
            {dm.discriminator && (
              <span className="ml-1 text-xs font-normal tracking-wide text-muted-foreground">
                #{dm.discriminator}
              </span>
            )}
          </Title>
        </>
      )}
      actions={notifLevel && <DmNotifDropdown level={notifLevel} onSetLevel={onSetNotifLevel} />}
    />
  )
}

function DmNotifDropdown({ level, onSetLevel }: { level: NotifLevel; onSetLevel?: (level: NotifLevel) => void }) {
  const muted = level === "Nothing"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button variant="ghost" size="icon-sm" className={muted ? "text-destructive" : "text-muted-foreground"} aria-label="Direct message notifications" />
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
    <MessageHeader
      leading={onBack ? (
        <div data-slot="loading-mobile-leading" aria-hidden className="grid size-11 shrink-0 place-items-center sm:hidden">
          <Skeleton className="size-6 rounded-md" />
        </div>
      ) : undefined}
      identityClassName="gap-2"
      identity={(
        <>
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-4 w-32 rounded" />
        </>
      )}
      actions={<Skeleton className="size-7 rounded-md" />}
    />
  )
}
