import type React from "react"
import { Inbox, Users } from "lucide-react"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"

// App shell — fixed full-screen frame with the window/title bar (app name + Inbox
// popover + help) and a content area. The `--d-rail` surface token (one step deeper
// than --sidebar) is scoped here. `inbox` is the popover body; `hasUnread` shows the dot.
export function Shell({ appName, appIcon, serverIcon, inbox, hasUnread, children }: {
  appName: string
  appIcon?: "friends"
  serverIcon?: string | null
  inbox: React.ReactNode
  hasUnread?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden font-sans text-[15px] text-foreground [--d-rail:oklch(0.95_0.006_80)] dark:[--d-rail:oklch(0.13_0.008_60)]">
      <header className="flex h-8 shrink-0 items-center justify-center px-3" style={{ background: "var(--d-rail)" }}>
        <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          {appIcon === "friends" ? (
            <Users className="size-4" />
          ) : serverIcon ? (
            <img src={serverIcon} alt={appName} className="size-4 rounded-sm object-cover" />
          ) : (
            <span className="grid size-4 place-items-center rounded-sm bg-primary text-[10px] font-semibold text-primary-foreground">{appName.charAt(0)}</span>
          )}
          {appName}
        </div>
        <div className="absolute right-3 flex items-center gap-3 text-muted-foreground">
          <Popover>
            <PopoverTrigger
              render={
                <button className="relative hover:text-foreground aria-expanded:text-foreground" aria-label="Inbox" />
              }
            >
              <Inbox className="size-4.5" />
              {hasUnread && <span className="absolute -right-1 -top-1 size-2 rounded-full bg-primary" />}
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="w-90 max-w-[calc(100vw-1rem)] overflow-hidden p-0">
              {inbox}
            </PopoverContent>
          </Popover>
          <span className="grid size-4.5 place-items-center rounded-full border border-current text-[11px]">?</span>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">{children}</div>
    </div>
  )
}
