"use client"

import type { PiiPlugin } from "@alook/shared"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { MoreHorizontal, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"


export function BotPiiList({
  botName,
  plugins,
  pending,
  unavailable,
  error,
  onSetEnabled,
  onDelete,
}: {
  botName: string
  plugins: readonly PiiPlugin[]
  pending: boolean
  unavailable?: string
  error?: string
  onSetEnabled: (id: string, enabled: boolean) => void
  onDelete: (id: string) => Promise<boolean>
}) {
  const [deletingId, setDeletingId] = useAtom(useCreateAtom<string | null>(null))
  const deleting = plugins.find((plugin) => plugin.id === deletingId)
  const disabled = pending || Boolean(unavailable)

  return (
    <div className="flex flex-col gap-4" data-testid="pii-pipeline" aria-busy={pending}>
      {pending ? <p role="status" className="text-sm text-muted-foreground">Waiting for this machine…</p> : null}
      {unavailable ? <p role="status" className="text-sm text-muted-foreground">{unavailable}</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {plugins.length === 0 ? (
        <div className="py-8">
          <h3 className="font-medium">No filters</h3>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">{botName} sends message text without PII filtering. Ask your bot to add a filter with Alook PII.</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Enabled filters run from top to bottom.</p>
          <ol className="flex flex-col">
            {plugins.map((plugin, index) => (
              <li key={plugin.id} className="relative flex items-start gap-2 pb-4 before:absolute before:top-8 before:bottom-0 before:left-3 before:w-px before:bg-border last:pb-0 last:before:hidden" data-testid={`pii-plugin-${plugin.id}`}>
                <span aria-hidden className="relative z-10 mt-2 grid size-6 shrink-0 place-items-center bg-background font-mono text-xs tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                <div className="flex min-w-0 flex-1 items-start gap-2">
                <div className="min-w-0 flex-1 pt-2">
                  <h3 className="wrap-break-word text-base font-medium">{plugin.name}</h3>
                  <p id={`pii-description-${plugin.id}`} className="mt-2 max-w-prose wrap-break-word text-sm leading-relaxed text-muted-foreground">{plugin.description}</p>
                  <span className="mt-2 block text-xs text-muted-foreground">{plugin.enabled ? "Enabled" : "Bypassed"}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <div className="flex size-11 items-center justify-center">
                    <Switch className="after:-inset-x-1.5 after:-inset-y-3.5" checked={plugin.enabled} disabled={disabled} onCheckedChange={(enabled) => onSetEnabled(plugin.id, enabled)} aria-label={`${plugin.name} filter`} aria-describedby={`pii-description-${plugin.id}`} data-testid={`pii-plugin-${plugin.id}-switch`} />
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-11" disabled={disabled} aria-label={`Actions for ${plugin.name}`} data-testid={`pii-plugin-${plugin.id}-menu`} />}>
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem variant="destructive" onClick={() => setDeletingId(plugin.id)}><Trash2 className="size-4" />Delete plugin</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open && !pending) setDeletingId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This removes the filter from {botName}’s pipeline on this machine. Disable it instead if you may need it again.</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {unavailable ? <p role="status" className="text-sm text-muted-foreground">{unavailable}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={disabled} variant="outline" className="border-destructive text-foreground hover:text-foreground" onClick={async () => { if (deleting && await onDelete(deleting.id)) setDeletingId(null) }}>
              {pending ? "Deleting…" : "Delete plugin"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
