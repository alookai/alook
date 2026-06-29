"use client"

import type React from "react"
import { Inbox, Settings } from "lucide-react"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Avatar } from "./avatar"
import type { OpenProfile } from "./_types"

export function UserBar({ user, onOpenProfile, onEditProfile, inbox, hasUnread, floating, rightInset }: {
  user: { name: string; avatar: string }
  onOpenProfile?: OpenProfile
  onEditProfile?: () => void
  inbox?: React.ReactNode
  hasUnread?: boolean
  floating?: boolean
  rightInset?: number
}) {
  if (floating) {
    return (
      <div
        className="fixed bottom-3 left-3 z-20 rounded-xl border border-border/60 bg-card px-3 py-2 shadow-[var(--e1)]"
        style={{ right: rightInset != null ? rightInset + 12 : undefined }}
      >
        <Inner user={user} onOpenProfile={onOpenProfile} onEditProfile={onEditProfile} inbox={inbox} hasUnread={hasUnread} />
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t border-border/40 px-4 py-3">
      <Inner user={user} onOpenProfile={onOpenProfile} onEditProfile={onEditProfile} inbox={inbox} hasUnread={hasUnread} />
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
    <div className="flex items-center gap-2.5">
      <button onClick={(e) => onOpenProfile?.(user.name, e)} className="shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Avatar label={user.avatar} size={28} presence="online" />
      </button>
      <button onClick={(e) => onOpenProfile?.(user.name, e)} className="min-w-0 flex-1 text-left rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <div className="truncate text-sm font-medium leading-tight">{user.name}</div>
      </button>
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
  )
}
