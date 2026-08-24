import { ChevronLeft, HelpCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { CreateTile } from "@/components/community/onboarding-tiles/create-tile"
import { CreateBotSheet } from "./create-bot-sheet"
import { renderBotMachineGroup } from "./bot-list-machine-group"
import { renderBotListOverlaySlots } from "./bot-list-overlays"
import type { BotListController, BotListProps } from "./bot-list-types"

function BotCardSkeleton() {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 py-0.5">
          <Skeleton className="h-3.5 w-28 rounded" />
          <Skeleton className="h-3 w-48 rounded" />
        </div>
        <Skeleton className="size-8 shrink-0 rounded-md" />
      </div>
    </Card>
  )
}

function botBackBar(onBack?: () => void, reserveBackSlot = false) {
  return onBack || reserveBackSlot ? (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-6">
      {onBack ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Back"
        >
          <ChevronLeft className="size-5" />
        </Button>
      ) : (
        <Skeleton data-slot="loading-back-placeholder" aria-hidden className="size-8 shrink-0 rounded-md" />
      )}
      <span className="ml-1 truncate text-base font-semibold">My Bots</span>
    </header>
  ) : null
}

export function BotListSkeleton({
  onBack,
  reserveBackSlot = false,
}: {
  onBack?: () => void
  reserveBackSlot?: boolean
} = {}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {botBackBar(undefined, reserveBackSlot || Boolean(onBack))}
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6 thin-scrollbar">
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Skeleton className="h-6 w-24 rounded" />
            <Skeleton className="h-4 w-full max-w-80 rounded" />
          </div>
          <div className="flex items-center gap-1">
            <Skeleton className="size-9 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
          </div>
        </header>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3 rounded-lg p-1">
            <div className="flex h-7 items-center gap-2 px-1">
              <Skeleton className="size-3 rounded" />
              <Skeleton className="size-3.5 rounded" />
              <Skeleton className="h-3 w-28 rounded" />
              <Skeleton className="size-1.5 rounded-full" />
              <Skeleton className="ml-auto h-7 w-20 rounded-md" />
            </div>
            <div className="flex flex-col gap-3">
              <BotCardSkeleton />
              <BotCardSkeleton />
              <BotCardSkeleton />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function renderBotListView(
  { onBack }: BotListProps,
  controller: BotListController,
) {
  const backBar = botBackBar(onBack)

  if ((controller.isLoading || controller.machinesLoading) && controller.bots.length === 0) {
    return <BotListSkeleton onBack={onBack} />
  }

  if (controller.bots.length === 0) {
    const needsMachine = controller.machines.length === 0
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {backBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-12 text-center">
          <div className="w-full max-w-70 overflow-hidden rounded-xl">
            <div className="aspect-200/130 w-full">
              <CreateTile />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-medium text-foreground">
              {needsMachine ? "Connect a machine first" : "No bots yet"}
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {needsMachine
                ? "Bots need a connected machine to run. Connect one first, then come back to create your bot."
                : "Create a bot and chat with it from anywhere — spin up servers and share it with family and friends."}
            </p>
          </div>
          <div data-onboarding-target="create-bot" className="w-fit">
            <Button
              onClick={needsMachine ? controller.openMachines : controller.openGuidedCreate}
            >
              {needsMachine ? "Connect a machine" : controller.guidedCreateLabel}
            </Button>
          </div>
        </div>
        <CreateBotSheet
          open={controller.createOpen}
          onOpenChange={controller.setCreateOpen}
          onCreated={controller.onBotCreated}
          guided={controller.guidedActive}
          avatarSeed={controller.guidedAvatarSeed}
        />
      </div>
    )
  }

  const overlays = renderBotListOverlaySlots(controller)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {backBar}
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto thin-scrollbar p-6">
        <header className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-medium text-foreground">My Bots</h1>
            <p className="text-sm text-muted-foreground">
              Bots you own — they show up as friends and can be added to any server.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="How your agent works"
              onClick={() => controller.setHelpOpen(true)}
              className="text-muted-foreground hover:text-foreground"
            >
              <HelpCircle className="size-5" />
            </Button>
            <div data-onboarding-target="create-bot" className="w-fit">
              <Button onClick={controller.openGuidedCreate}>{controller.guidedCreateLabel}</Button>
            </div>
          </div>
        </header>

        <div className="flex flex-col gap-6">
          {controller.groups.map((group) => renderBotMachineGroup(group, controller))}
        </div>
      </div>

      {overlays.create}
      {overlays.help}
      {overlays.edit}
      {overlays.activity}
      {overlays.bug}
      {overlays.deleteDialog}
      {overlays.resetDialog}
      {overlays.resetMachineDialog}
    </div>
  )
}
