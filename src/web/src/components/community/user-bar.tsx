"use client"

import { Sun, Moon, Settings } from "lucide-react"
import { useTheme } from "next-themes"
import { Avatar } from "./avatar"
import type { OpenProfile } from "./_types"

// Bottom user bar — current user's avatar/name + settings + theme toggle.
export function UserBar({ user, mounted, onOpenProfile, onEditProfile }: {
  user: { name: string; avatar: string }
  mounted: boolean
  onOpenProfile?: OpenProfile
  onEditProfile?: () => void
}) {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <div className="shrink-0 px-2 pb-2 pt-0">
      <div className="flex h-14 items-center gap-3 rounded-lg bg-secondary p-4">
        <button onClick={(e) => onOpenProfile?.(user.name, e)} className="shrink-0">
          <Avatar label={user.avatar} size={32} presence="online" />
        </button>
        <button onClick={(e) => onOpenProfile?.(user.name, e)} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-medium leading-tight">{user.name}</div>
          <div className="truncate text-xs leading-tight text-muted-foreground">Online</div>
        </button>
        <button
          onClick={onEditProfile}
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Edit profile"
        >
          <Settings className="size-5" />
        </button>
        <button
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Toggle theme"
        >
          {mounted && (resolvedTheme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />)}
        </button>
      </div>
    </div>
  )
}
