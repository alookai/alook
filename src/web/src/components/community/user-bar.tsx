"use client"

import { Sun, Moon, Settings } from "lucide-react"
import { useTheme } from "next-themes"
import { Avatar } from "./avatar"
import type { OpenProfile } from "./_types"

export function UserBar({ user, mounted, onOpenProfile, onEditProfile }: {
  user: { name: string; avatar: string }
  mounted: boolean
  onOpenProfile?: OpenProfile
  onEditProfile?: () => void
}) {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <div className="shrink-0 border-t border-border/40 px-4 py-2">
      <div className="flex items-center gap-2">
        <button onClick={(e) => onOpenProfile?.(user.name, e)} className="shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <Avatar label={user.avatar} size={28} presence="online" />
        </button>
        <button onClick={(e) => onOpenProfile?.(user.name, e)} className="min-w-0 flex-1 text-left rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <div className="truncate text-sm font-medium leading-tight">{user.name}</div>
        </button>
        <button
          onClick={onEditProfile}
          className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label="Edit profile"
        >
          <Settings className="size-4" />
        </button>
        <button
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label="Toggle theme"
        >
          {mounted && (resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />)}
        </button>
      </div>
    </div>
  )
}
