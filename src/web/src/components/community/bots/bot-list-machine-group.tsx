import { Activity, ChevronDown, Monitor, MoreVertical, RotateCcw } from "lucide-react"
import { formatModelLabel, isPresenceOnline } from "@alook/shared"
import { AgentAvatar } from "@/components/avatar"
import { ProviderLogo } from "@/components/provider-logo"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatAwakeDuration } from "@/lib/community/format-time"
import { tid } from "@/lib/community/testids"
import { MachineQuotaSummary } from "./bot-quota-summary"
import { BotTokenUsageHeatmap } from "./bot-token-usage-chart"
import type { BotListController, BotMachineGroup } from "./bot-list-types"

export function renderBotMachineGroup(
  { machineId, machine, bots }: BotMachineGroup,
  controller: BotListController,
) {
  const machineOnline = isPresenceOnline(machine?.status)
  const collapsed = controller.collapsedMachines.has(machineId)
  const label = controller.machineName(machineId)
  return (
    <div
      key={machineId}
      ref={(element) => {
        controller.groupRefs.current[machineId] = element
      }}
      className={[
        "flex flex-col gap-3 rounded-lg p-1 transition-colors duration-500",
        controller.highlightId === machineId ? "bg-primary/5 ring-2 ring-primary/40" : "",
      ].join(" ")}
    >
      <div className="flex flex-col gap-1 px-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
            onClick={() => {
              controller.setCollapsedMachines((current) => {
                const next = new Set(current)
                if (next.has(machineId)) next.delete(machineId)
                else next.add(machineId)
                return next
              })
            }}
          >
            <ChevronDown
              className={`size-3 shrink-0 text-muted-foreground transition-transform ${collapsed ? "-rotate-90" : ""}`}
            />
            <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-xs font-medium text-muted-foreground">
              {label}
            </span>
            <span
              className={[
                "inline-block size-1.5 shrink-0 rounded-full",
                machineOnline ? "bg-status-online" : "bg-muted-foreground",
              ].join(" ")}
            />
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => controller.setConfirmResetMachine(machineId)}
          >
            <RotateCcw className="size-3.5" />
            Reset all
          </Button>
        </div>
        <div className="pl-5">
          <MachineQuotaSummary machineId={machineId} entries={machine?.quota} />
        </div>
      </div>
      <div className="flex flex-col gap-3" hidden={collapsed}>
        {bots.map((bot) => {
          const online = controller.profilesByUserId.get(bot.id)?.presence === "online"
          return (
            <Card key={bot.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <AgentAvatar name={bot.name} avatarUrl={bot.image} seed={bot.id} size={40} />
                <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-2.5">
                  <div className="flex min-w-55 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[15px] font-medium text-foreground">
                        {bot.name}
                      </span>
                      <span
                        className={[
                          "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium",
                          online
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "bg-muted text-muted-foreground",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "inline-block size-1.5 rounded-full",
                            online ? "bg-status-online" : "bg-muted-foreground",
                          ].join(" ")}
                        />
                        {online ? "Online" : "Offline"}
                      </span>
                      {!online && machine && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 shrink-0 px-2 text-xs"
                          onClick={(event) => {
                            event.stopPropagation()
                            controller.bringMachineOnline(machine.id)
                          }}
                        >
                          Bring online
                        </Button>
                      )}
                    </div>
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <ProviderLogo provider={bot.runtime} className="size-3.5 shrink-0" />
                        <span>{bot.runtime}</span>
                      </span>
                      <span aria-hidden className="shrink-0">·</span>
                      {formatModelLabel(bot.runtime, bot.modelName) ? (
                        <span data-testid={tid.botCardModel} className="font-mono">
                          {formatModelLabel(bot.runtime, bot.modelName)}
                        </span>
                      ) : (
                        <span
                          data-testid={tid.botCardModel}
                          className="font-mono text-muted-foreground/70"
                          title="No model set — uses the machine's local default"
                        >
                          local default
                        </span>
                      )}
                      {bot.lastRefreshContextAt && (
                        <>
                          <span aria-hidden className="shrink-0">·</span>
                          <span className="shrink-0">
                            {formatAwakeDuration(bot.lastRefreshContextAt)}
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                  {bot.usage?.capability === "supported" && (
                    <BotTokenUsageHeatmap
                      botId={bot.id}
                      usage={bot.usage}
                      className="self-center"
                    />
                  )}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button
                        aria-label="Bot actions"
                        className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <MoreVertical className="size-4" />
                      </button>
                    }
                  />
                  <DropdownMenuContent align="end" className="w-auto min-w-36 max-w-56">
                    <DropdownMenuItem onClick={() => controller.chatWithBot(bot)}>
                      <span className="size-4" aria-hidden /> Chat
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => controller.openActivity(bot)}
                    >
                      <Activity className="size-4" /> View activity
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        controller.setEditingBot(bot)
                        controller.setEditOpen(true)
                      }}
                    >
                      <span className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid={`bot-reset-session-item`}
                      onClick={() => controller.setConfirmReset(bot)}
                    >
                      <RotateCcw className="size-4" /> Reset
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid={tid.botReportProblemItem}
                      onClick={() => {
                        controller.setBugReportBot({ id: bot.id, name: bot.name })
                        controller.setBugReportOpen(true)
                      }}
                    >
                      <span className="size-4" aria-hidden /> Report a problem
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => controller.setConfirmDelete(bot)}
                    >
                      <span className="size-4" aria-hidden /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
