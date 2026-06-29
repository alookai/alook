import { Pin, UserPlus, ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar } from "./avatar"
import type { DM } from "./_types"

// DM conversation header — avatar + name + pin/add-friend actions.
export function DmHeader({ dm, onBack, onOpenPins, onAddFriend }: {
  dm: DM
  onBack?: () => void
  onOpenPins?: () => void
  onAddFriend?: () => void
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      <Avatar label={dm.avatar} size={24} presence={dm.status} />
      <h1 className="truncate text-base font-medium">{dm.name}</h1>
      <div className="ml-auto flex items-center gap-0.5 text-muted-foreground">
        <Button variant="ghost" size="icon-sm" onClick={onOpenPins} className="text-muted-foreground hover:text-foreground" aria-label="Pinned"><Pin className="size-5" /></Button>
        <Button variant="ghost" size="icon-sm" onClick={onAddFriend} className="text-muted-foreground hover:text-foreground" aria-label="Add friend"><UserPlus className="size-5" /></Button>
      </div>
    </header>
  )
}
