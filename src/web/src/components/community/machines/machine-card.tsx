"use client"

import { useMemo } from "react"
import { Monitor, MoreVertical } from "lucide-react"
import type { CommunityMachineSummary } from "@alook/shared"
import { Card } from "@/components/ui/card"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { timeAgo } from "@/lib/time"
import { MachineRuntimes } from "./machine-runtimes"

export function MachineCard({
  machine,
  onDelete,
  onReconnect,
}: {
  machine: CommunityMachineSummary
  onDelete: () => void
  onReconnect: () => void
}) {
  const isOnline = machine.status === "online"
  const lastSeenLabel = useMemo(
    () => (machine.lastSeenAt ? `Last seen · ${timeAgo(machine.lastSeenAt)}` : "Never seen"),
    [machine.lastSeenAt]
  )
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-secondary text-muted-foreground">
            <Monitor className="size-5" />
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-medium text-foreground">
                {machine.hostname || "Unnamed machine"}
              </span>
              <span
                className={[
                  "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium",
                  isOnline
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground",
                ].join(" ")}
              >
                <span
                  className={[
                    "inline-block size-1.5 rounded-full",
                    isOnline ? "bg-emerald-500" : "bg-muted-foreground/40",
                  ].join(" ")}
                />
                {isOnline ? "Online" : "Offline"}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {[machine.platform, machine.arch].filter(Boolean).join(" · ")}
              {machine.daemonVersion ? ` · v${machine.daemonVersion}` : ""}
            </span>
            <MachineRuntimes runtimes={machine.availableRuntimes} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="text-xs text-muted-foreground" />
                }
              >
                {lastSeenLabel}
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {machine.lastSeenAt ?? "—"}
              </TooltipContent>
            </Tooltip>
            {machine.lastRuntimeError && (
              <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 p-2 text-xs text-destructive">
                <span className="font-medium">Runtime not available</span>
                <span className="ml-1 text-destructive/80">
                  — requested {machine.lastRuntimeError.requested || "runtime"}, installed:{" "}
                  {machine.lastRuntimeError.available.length > 0
                    ? machine.lastRuntimeError.available.join(", ")
                    : "none"}
                </span>
              </div>
            )}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                aria-label="Machine actions"
                className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <MoreVertical className="size-4" />
              </button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onReconnect}>
              Reconnect…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete} className="text-destructive">
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  )
}
