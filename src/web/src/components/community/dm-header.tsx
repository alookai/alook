import { ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar } from "./avatar"
import type { DM } from "./_types"

export function DmHeader({ dm, onBack }: {
  dm: DM
  onBack?: () => void
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      <Avatar label={dm.avatar} size={24} presence={dm.status} />
      <h1 className="truncate text-base font-medium">{dm.name}</h1>
    </header>
  )
}
