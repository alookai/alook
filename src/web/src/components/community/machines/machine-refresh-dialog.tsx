"use client"

import type { MachineSummary } from "@/hooks/community/use-machines"
import { machineName } from "@/lib/community/machine-name"
import { tid } from "@/lib/community/testids"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"

export function MachineRefreshDialog({ machine, onOpenChange, onConfirm }: {
  machine: MachineSummary | null
  onOpenChange: (open: boolean) => void
  onConfirm: (machine: MachineSummary) => void
}) {
  return (
    <AlertDialog open={Boolean(machine)} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Refresh {machine ? machineName(machine) : "machine"}?</AlertDialogTitle>
          <AlertDialogDescription>
            Restart the daemon with the latest shell environment. Running bots will be interrupted.
            The machine will reconnect on the same daemon version.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" data-testid={tid.machineRefreshConfirm} onClick={() => machine && onConfirm(machine)}>
            Refresh machine
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
