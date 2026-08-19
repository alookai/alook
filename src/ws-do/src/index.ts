import { handleAuditBroadcast } from "./routes/audit-broadcast"
import {
  handleCommunityUserBroadcast,
  handleCommunityUsersBroadcast,
  handleDaemonBroadcast,
  handleUserBroadcast,
  handleUsersBroadcast,
} from "./routes/broadcast"
import { handleMachinePush, handleMachineWake } from "./routes/community-machine-delivery"
import { handleMachineDiagnostics } from "./routes/community-machine-diagnostics"
import { handleMessageDelivery } from "./routes/message-delivery"
import {
  handleMachineBatchReset,
  handleMachineForceClose,
  handleMachineNap,
  handleMachineReset,
  handleMachineUpdate,
} from "./routes/community-machine-lifecycle"
import { handleMachineModelSwitch, handleMachineProviderSwitch } from "./routes/community-machine-switch"
import { handleHealth } from "./routes/health"
import { handleBatchPresence, handleSinglePresence } from "./routes/presence"
import { handleRateLimit } from "./routes/rate-limit"
import { log, type RouterContext } from "./router-context"
import { handleUpgrade } from "./routes/upgrade"

export { WebSocketDurableObject } from "./ws-durable"
export { RateLimitDurableObject } from "./rate-limit-do"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    let response = handleHealth(request, url)
    if (response) return response

    response = await handleRateLimit(request, env, url)
    if (response) return response

    const context: RouterContext = {
      request,
      env,
      url,
      traceId: request.headers.get("X-Trace-Id") ?? undefined,
      log,
    }

    response = await handleDaemonBroadcast(context)
    if (response) return response
    response = await handleCommunityUserBroadcast(context)
    if (response) return response
    response = await handleCommunityUsersBroadcast(context)
    if (response) return response
    response = await handleMessageDelivery(context)
    if (response) return response
    response = await handleUserBroadcast(context)
    if (response) return response
    response = await handleUsersBroadcast(context)
    if (response) return response
    response = await handleAuditBroadcast(context)
    if (response) return response
    response = await handleBatchPresence(context)
    if (response) return response
    response = await handleSinglePresence(context)
    if (response) return response
    response = await handleMachinePush(context)
    if (response) return response
    response = await handleMachineWake(context)
    if (response) return response
    response = await handleMachineDiagnostics(context)
    if (response) return response
    response = await handleMachineReset(context)
    if (response) return response
    response = await handleMachineUpdate(context)
    if (response) return response
    response = await handleMachineBatchReset(context)
    if (response) return response
    response = await handleMachineModelSwitch(context)
    if (response) return response
    response = await handleMachineProviderSwitch(context)
    if (response) return response
    response = await handleMachineNap(context)
    if (response) return response
    response = await handleMachineForceClose(context)
    if (response) return response

    return handleUpgrade(context)
  },
}
