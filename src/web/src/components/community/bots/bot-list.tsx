"use client"

import { useState } from "react"
import { ChevronLeft, Bot as BotIcon, MoreVertical, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AgentAvatar } from "@/components/avatar"
import { ProviderLogo } from "@/components/provider-logo"
import { useMachines } from "@/hooks/community/use-machines"
import { useBots, useDeleteBot, type BotSummary } from "@/hooks/community/use-bots"
import { useOnlineUserIds } from "@/stores/community/ws"
import { CreateBotDialog } from "./create-bot-dialog"
import { EditBotDialog } from "./edit-bot-dialog"

/**
 * BotList — the /community/me/bots surface.
 *
 * Visual language matches the sibling MachineList: a back-bar header, a
 * 6-unit-padded scroll region, header/CTA row, Card rows with a 40px avatar,
 * status pill, meta line, and a kebab menu. Empty state matches the machine
 * empty state so users don't learn two idioms.
 */
export function BotList({ onBack }: { onBack?: () => void } = {}) {
  const { bots, isLoading } = useBots()
  const { machines } = useMachines()
  // Presence read: single API for humans + bots. The community-shell bridge
  // hydrates own-bot ids into the same set, so a bot row's "online" pill
  // uses the same signal every other surface (DM sidebar, friend list,
  // mention popover) reads from — no code-path divergence.
  const onlineUserIds = useOnlineUserIds()
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<BotSummary | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<BotSummary | null>(null)
  const del = useDeleteBot()

  const machineName = (id: string): string => {
    const m = machines.find((x) => x.id === id)
    if (!m) return "Unknown machine"
    return m.displayName?.trim() || m.hostname?.trim() || "Unnamed machine"
  }

  const backBar = onBack ? (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-6">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onBack}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Back"
      >
        <ChevronLeft className="size-5" />
      </Button>
      <span className="ml-1 truncate text-base font-semibold">My Bots</span>
    </header>
  ) : null

  if (isLoading && bots.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {backBar}
        <div className="flex flex-col gap-3 p-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-[84px] animate-pulse rounded-lg border bg-muted/30" />
          ))}
        </div>
      </div>
    )
  }

  if (bots.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {backBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-12 text-center">
          <div className="grid size-12 place-items-center rounded-2xl bg-secondary text-muted-foreground">
            <BotIcon className="size-6" />
          </div>
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-medium text-foreground">No bots yet</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Give your daemon a voice. A bot is a first-class community member you own,
              bound to a paired machine and a runtime.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>Create a bot</Button>
        </div>
        <CreateBotDialog open={createOpen} onOpenChange={setCreateOpen} />
      </div>
    )
  }

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
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Create a bot
          </Button>
        </header>

        <div className="flex flex-col gap-3">
          {bots.map((bot) => {
            const online = onlineUserIds.has(bot.id)
            return (
              <Card key={bot.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <AgentAvatar name={bot.name} avatarUrl={bot.image} size={40} />
                    <div className="flex min-w-0 flex-col gap-1">
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
                              online ? "bg-emerald-500" : "bg-muted-foreground/40",
                            ].join(" ")}
                          />
                          {online ? "Online" : "Offline"}
                        </span>
                      </div>
                      <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                        <ProviderLogo provider={bot.runtime} className="size-3.5 shrink-0" />
                        <span className="truncate">
                          {bot.runtime} · {machineName(bot.machineId)}
                        </span>
                      </span>
                    </div>
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
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditing(bot)}>
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setConfirmDelete(bot)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </Card>
            )
          })}
        </div>
      </div>

      <CreateBotDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editing && (
        <EditBotDialog
          bot={editing}
          open={!!editing}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The bot will leave every server it&apos;s in and its runner key will be
              revoked. Past messages remain in history with the bot&apos;s current name
              and avatar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!confirmDelete) return
                const name = confirmDelete.name
                try {
                  await del.mutateAsync(confirmDelete.id)
                  toast.success(`Deleted ${name}`)
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Couldn't delete the bot")
                } finally {
                  setConfirmDelete(null)
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
