import type { ReactNode } from "react"
import { formatModelLabel } from "@alook/shared"
import { AgentAvatar } from "@/components/avatar"
import { ProviderLogo } from "@/components/provider-logo"
import { Card } from "@/components/ui/card"
import { formatAwakeDuration } from "@/lib/community/format-time"
import { tid } from "@/lib/community/testids"
import { runtimeLabel } from "@/lib/community/runtime-label"
import type { BotSummary } from "@/lib/community/bots"
import { PresenceStatus } from "../presence-status"
import { BotTokenUsageHeatmap } from "./bot-token-usage-chart"

type BotCardData = Pick<BotSummary, "id" | "name" | "image" | "runtime" | "modelName" | "lastRefreshContextAt" | "usage">

export function BotCardView({ bot, online, statusKnown, statusLabel, statusAction, actions }: {
  bot: BotCardData
  online: boolean
  statusKnown: boolean
  statusLabel?: string
  statusAction?: ReactNode
  actions?: ReactNode
}) {
  return (
    <Card data-shell="cassette" className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <AgentAvatar name={bot.name} avatarUrl={bot.image} seed={bot.id} size={40} />
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-2.5">
          <div className="flex min-w-0 basis-55 grow flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span title={bot.name} className="min-w-0 max-w-full truncate text-[15px] font-medium text-foreground">
                {bot.name}
              </span>
              <PresenceStatus online={online === true} label={statusLabel ?? (!statusKnown ? "Status unknown" : online ? "Online" : "Offline")} />
              {statusAction}
            </div>
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
              <span className="flex min-w-0 max-w-full items-center gap-1.5">
                <ProviderLogo provider={bot.runtime} className="size-3.5 shrink-0" />
                <span className="truncate" title={runtimeLabel(bot.runtime)}>{runtimeLabel(bot.runtime)}</span>
              </span>
              <span aria-hidden className="shrink-0">·</span>
              {formatModelLabel(bot.runtime, bot.modelName) ? (
                <span data-testid={tid.botCardModel} title={bot.modelName ?? undefined} className="min-w-0 max-w-full truncate font-mono">
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
        {actions}
      </div>
    </Card>
  )
}
