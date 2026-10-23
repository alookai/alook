"use client"

import { Monitor, Box, Gauge, Check } from "lucide-react"
import { ScrollArea } from "@base-ui/react/scroll-area"
import type { BotCreationItem, BotCreationPayload } from "@alook/shared"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ProfileAvatar, SeededBackdrop } from "@/components/avatar"
import { ProviderLogo } from "@/components/provider-logo"
import { useBotCreationDecision } from "@/hooks/community/mutations/bot-creation"
import { useCanonicalCommunityProfile } from "@/lib/community-db/projections"
import { runtimeLabel } from "@/lib/community/runtime-label"
import { isAbortError } from "@/lib/errors"
import { tid } from "@/lib/community/testids"
import type { OpenProfile } from "./profile-types"
import styles from "./bot-creation-request-card.module.css"

export function BotCreationRequestCard({ request, messageId, viewerUserId, onOpenProfile }: {
  request: BotCreationPayload
  messageId: string
  viewerUserId?: string
  onOpenProfile?: OpenProfile
}) {
  const decide = useBotCreationDecision()
  const count = request.bots.length
  const pending = request.status === "pending"
  const actionable = pending && viewerUserId === request.ownerUserId
  const error = actionable && !isAbortError(decide.error) ? decide.error : null
  const submit = (decision: "approve" | "decline") => {
    if (decide.isPending) return
    decide.mutate({ requestId: request.requestId, messageId, decision })
  }

  return (
    <section className={`flex w-full min-w-0 flex-col ${count > 1 ? "max-w-2xl" : "max-w-80"}`}
      aria-label="Bot creation request" data-testid={tid.botCreationRequestCard} data-request-status={request.status}>
      <ScrollArea.Root className={count > 1 ? "min-w-0 pb-4" : "min-w-0"} data-swipe-ignore="">
        <ScrollArea.Viewport role="group" aria-label="Proposed bots" tabIndex={0}
          className="min-w-0 snap-x snap-mandatory overscroll-x-contain rounded-sm focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <ScrollArea.Content className="flex gap-4 p-2">
            {request.bots.map((bot) => <BotProposal key={bot.itemId} bot={bot} approved={request.status === "approved"} onOpenProfile={onOpenProfile} />)}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="horizontal" className="mx-2 flex h-6 items-center px-1">
          <ScrollArea.Thumb className="relative h-full after:pointer-events-none after:absolute after:inset-x-0 after:top-1/2 after:h-1 after:-translate-y-1/2 after:rounded-full after:bg-border hover:after:bg-muted-foreground active:after:bg-muted-foreground" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
      {actionable ? (
        <div className="flex flex-col gap-2 px-2">
          {error && <p role="alert" className="wrap-anywhere text-sm text-destructive">{error.message}</p>}
          <div className="flex justify-end gap-2" aria-busy={decide.isPending}>
            <Button size="sm" variant="ghost" className="h-11 sm:h-9" disabled={decide.isPending}
              data-testid={tid.botCreationDecline} onClick={() => submit("decline")}>
              {decide.isPending && decide.variables?.decision === "decline" ? "Declining…" : "Decline"}
            </Button>
            <Button size="sm" className="h-11 sm:h-9" disabled={decide.isPending}
              data-testid={tid.botCreationApprove} onClick={() => submit("approve")}>
              {decide.isPending && decide.variables?.decision === "approve" ? "Creating…" : `Create ${count === 1 ? "bot" : `${count} bots`}`}
            </Button>
          </div>
        </div>
      ) : request.status === "approved" ? null : <p role="status" className="text-xs font-medium text-muted-foreground">
        {pending ? "Waiting for your owner’s decision" : "Declined"}
      </p>}
    </section>
  )
}

function BotProposal({ bot, approved, onOpenProfile }: { bot: BotCreationItem; approved: boolean; onOpenProfile?: OpenProfile }) {
  const identity = bot.createdBot
  const canonical = useCanonicalCommunityProfile(identity?.id)
  const name = canonical?.name ?? identity?.name ?? bot.name
  const discriminator = canonical?.discriminator ?? identity?.discriminator
  const seed = identity?.id ?? bot.itemId
  const avatar = canonical ? canonical.avatar : identity?.image
  const heading = <><span className="min-w-0 truncate">{name}</span>{identity && <span className="ml-1.5 shrink-0 text-sm font-normal tracking-wide text-muted-foreground">#{discriminator}</span>}</>
  const badgeClass = "shrink-0 whitespace-nowrap text-left"

  return <article className={`${styles.card} relative flex h-70 w-70 min-w-0 shrink-0 snap-start flex-col overflow-hidden rounded-xl border border-border bg-popover p-2`} aria-label={bot.name}>
    {approved && <span role="img" aria-label="Approved" title="Approved" className="absolute left-2 top-2 z-10 flex size-5 items-center justify-center rounded-full border border-border bg-popover text-foreground"><Check aria-hidden className="size-3.5" /></span>}
    <div className="relative -m-2 mb-0 h-12 shrink-0 overflow-hidden rounded-t-lg">
      <SeededBackdrop seed={seed} />
    </div>
    <div className="relative -mt-7 mb-2 flex shrink-0 items-end gap-2 px-2">
      <div className="shrink-0 rounded-full ring-[5px] ring-popover">
        <ProfileAvatar label={name} seed={seed} src={avatar} size={56} />
      </div>
      <div title={runtimeLabel(bot.backendId)} className="flex min-w-0 max-w-32 translate-y-1 items-center gap-2 rounded-full border border-border bg-secondary px-2 py-0.5 text-[13px] text-secondary-foreground shadow-(--e1)">
        <ProviderLogo provider={bot.backendId} className="size-3.5 shrink-0" />
        <span className="truncate">{runtimeLabel(bot.backendId)}</span>
      </div>
    </div>
    <div className="mx-1 mb-1 flex min-h-0 flex-1 flex-col rounded-lg bg-card p-3">
      {identity && onOpenProfile ? <button type="button" aria-label={`${name}#${discriminator}`} title={`${name}#${discriminator}`}
        className="flex min-h-11 min-w-0 shrink-0 items-baseline text-left text-lg font-semibold leading-tight tracking-[-0.015em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-7"
        onClick={(event) => onOpenProfile(name, event, discriminator, identity.id)}>{heading}</button>
        : <p title={name} className="flex min-w-0 shrink-0 items-baseline text-lg font-semibold leading-tight tracking-[-0.015em]">{heading}</p>}
      <div tabIndex={0} aria-label={`${name} reason`} className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-y-contain rounded-sm pr-2 thin-scrollbar focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <p className="wrap-anywhere whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{bot.reason}</p>
      </div>
      <div tabIndex={0} aria-label={`${name} configuration`} className="mt-3 flex shrink-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain rounded-sm thin-scrollbar focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <Badge variant="secondary" className={badgeClass} title={`Machine: ${bot.machineName}`}><Monitor aria-hidden />{bot.machineName}</Badge>
        {bot.model && <Badge variant="secondary" className={badgeClass} title={`Model: ${bot.model}`}><Box aria-hidden />{bot.model}</Badge>}
        {bot.reasoningEffort && <Badge variant="secondary" className={badgeClass} title={`Effort: ${bot.reasoningEffort}`}><Gauge aria-hidden />{bot.reasoningEffort}</Badge>}
      </div>
    </div>
  </article>
}
