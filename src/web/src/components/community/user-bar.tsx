"use client"

import type React from "react"
import { Inbox, Settings } from "lucide-react"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Avatar } from "./avatar"
import type { OpenProfile } from "./_types"

export function UserBar({ user, onOpenProfile, onEditProfile, inbox, hasUnread }: {
  user: { name: string; avatar: string }
  onOpenProfile?: OpenProfile
  onEditProfile?: () => void
  inbox?: React.ReactNode
  hasUnread?: boolean
}) {
  return (
    <div className="shrink-0 px-3 pb-3 pt-0">
      <div className="flex h-12 items-center gap-3 rounded-xl bg-muted px-4 ring-1 ring-border/40">
        <Inner user={user} onOpenProfile={onOpenProfile} onEditProfile={onEditProfile} inbox={inbox} hasUnread={hasUnread} />
      </div>
    </div>
  )
}

function Inner({ user, onOpenProfile, onEditProfile, inbox, hasUnread }: {
  user: { name: string; avatar: string }
  onOpenProfile?: OpenProfile
  onEditProfile?: () => void
  inbox?: React.ReactNode
  hasUnread?: boolean
}) {
  return (
    <div className="flex flex-1 items-center gap-2">
      <button onClick={(e) => onOpenProfile?.(user.name, e)} className="shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Avatar label={user.avatar} size={28} presence="online" />
      </button>
      <button onClick={(e) => onOpenProfile?.(user.name, e)} className="min-w-0 flex-1 text-left rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <div className="truncate text-sm font-medium leading-tight">{user.name}</div>
      </button>
      <div className="flex items-center gap-1">
        {inbox && (
          <Popover>
            <PopoverTrigger
              render={
                <button className="relative grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label="Inbox" />
              }
            >
              <Inbox className="size-4" />
              {hasUnread && <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />}
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="w-90 max-w-[calc(100vw-1rem)] overflow-hidden p-0">
              {inbox}
            </PopoverContent>
          </Popover>
        )}
        <button
          onClick={onEditProfile}
          className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label="User settings"
        >
          <Settings className="size-4" />
        </button>
      </div>
    </div>
  )
}
