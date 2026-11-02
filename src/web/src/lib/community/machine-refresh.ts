import type { QueryClient } from "@tanstack/react-query"
import type { MachineRefreshResult } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"

export type MachineRefreshState = { requestId: string } & (
  | { status: "pending"; phase: "sending" | "restarting"; deadlineAt: number }
  | { status: "complete" }
  | { status: "error" | "unconfirmed"; message: string }
)

const refreshErrors: Record<Extract<MachineRefreshResult, { status: "error" }>["code"], string> = {
  environment_unavailable: "Could not load the shell environment. The daemon was not restarted. Check this computer’s shell setup and try again.",
  refresh_in_progress: "Another refresh is already running. Wait for this machine to reconnect before trying again.",
  restart_failed: "The daemon could not restart. Check this computer and reconnect if needed.",
  ownership_changed: "The machine connection changed during refresh. Check its current status before trying again.",
}

export function receiveMachineRefreshResult(queryClient: QueryClient, machineId: string, result: MachineRefreshResult) {
  queryClient.setQueryData<MachineRefreshState>(communityKeys.machineRefresh(machineId), current => {
    if (!current || current.requestId !== result.requestId || !["pending", "unconfirmed"].includes(current.status)) return current
    return result.status === "complete"
      ? { requestId: result.requestId, status: "complete" }
      : { requestId: result.requestId, status: "error", message: refreshErrors[result.code] }
  })
}
