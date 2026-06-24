"use client"

import { Users } from "lucide-react"
import { Avatar } from "./avatar"
import type { DM } from "./_types"

// DM list sidebar (@me view).
export function DmSidebar({
  dms, activeDm, onPickDm, onShowFriends, bordered, noHeader,
}: {
  dms: DM[]
  activeDm: string | null
  onPickDm: (id: string) => void
  onShowFriends: () => void
  bordered?: boolean
  noHeader?: boolean
}) {
  return (
    <aside className={`flex min-w-0 flex-1 flex-col ${bordered ? "rounded-tl-xl border-l border-t border-border" : ""}`}>
      <div className="flex-1 overflow-y-auto thin-scrollbar px-2 py-3">
        <button
          onClick={onShowFriends}
          className={[
            "mb-2 flex h-9 w-full items-center gap-2 rounded-md px-2 text-[15px] font-medium",
            activeDm === null ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          ].join(" ")}
        >
          <Users className="size-5" /> Friends
        </button>
        <div className="my-2 h-px bg-border" />
        <div className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Direct Messages
        </div>
        {dms.map((d) => {
          const active = d.id === activeDm
          return (
            <button
              key={d.id}
              onClick={() => onPickDm(d.id)}
              className={[
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5",
                active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              ].join(" ")}
            >
              <Avatar label={d.avatar} size={32} presence={d.status} />
              <div className="min-w-0 flex-1 text-left">
                <div className="truncate text-[15px] leading-tight text-foreground">{d.name}</div>
                <div className="truncate text-xs leading-tight text-muted-foreground">{d.preview}</div>
              </div>
              {d.unread && <span className="size-2 shrink-0 rounded-full bg-primary" />}
            </button>
          )
        })}
      </div>
    </aside>
  )
}
