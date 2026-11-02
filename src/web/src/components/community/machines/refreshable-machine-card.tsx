"use client"

import type { ComponentProps } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { isPresenceOnline } from "@alook/shared"
import { useMachineRefresh } from "@/hooks/community/use-machine-refresh"
import { MachineCard } from "./machine-card"
import { MachineRefreshDialog } from "./machine-refresh-dialog"

export function RefreshableMachineCard(props: Omit<ComponentProps<typeof MachineCard>, "onRefresh" | "refreshFeedback">) {
  const [confirm, setConfirm] = useAtom(useCreateAtom(false))
  const { refresh, feedback, isPending } = useMachineRefresh(props.machine.id)
  const available = isPresenceOnline(props.machine.status) && !props.stopping && !isPending
  return <>
    <MachineCard {...props} onRefresh={() => { if (available) setConfirm(true) }} refreshFeedback={feedback} />
    <MachineRefreshDialog
      machine={confirm && available ? props.machine : null}
      onOpenChange={setConfirm}
      onConfirm={() => {
        setConfirm(false)
        if (available) void refresh()
      }}
    />
  </>
}
