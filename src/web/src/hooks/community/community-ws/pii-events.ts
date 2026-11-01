import type { PiiResult } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import type { BotPiiState } from "../use-bot-pii"
import type { PresenceMachineEventContext } from "./handler-context"

export function handleBotPii(event: { machineId: string; botId: string; requestId: string; result: PiiResult }, { queryClient }: PresenceMachineEventContext) {
  const key = communityKeys.botPii(event.machineId, event.botId)
  const pending = queryClient.getQueryData<BotPiiState>(key)
  if (pending?.status !== "pending" || pending.requestId !== event.requestId) return
  const result = event.result
  const preview = pending.operation === "preview"
  if (result.status === "complete") {
    queryClient.setQueryData<BotPiiState>(key, {
      requestId: event.requestId, operation: pending.operation, snapshot: result.snapshot,
      status: preview && result.output === undefined ? "error" : "complete",
      output: preview ? result.output : undefined,
      triggeredFilters: preview && result.output !== undefined ? result.triggeredFilters : undefined,
      error: preview && result.output === undefined ? "Could not read the test result. Run it again." : undefined,
    })
    return
  }
  queryClient.setQueryData<BotPiiState>(key, {
    requestId: event.requestId, operation: pending.operation, status: "error", snapshot: result.snapshot ?? pending.snapshot,
    uncertain: !preview && !result.snapshot,
    error: result.code === "PII_CONFLICT" ? "Filters changed elsewhere. Review the updated list and try again."
      : result.code === "PII_PLUGIN_NOT_FOUND" ? "This plugin was removed. Reload filters."
      : preview ? "The filters could not process this message. Check the filters and try again."
      : "Filters are unavailable. Reload to try again.",
  })
}
