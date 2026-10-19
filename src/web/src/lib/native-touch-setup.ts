import { tauriInvoke } from "@alook/shared"
import { parseTouchGrant, touchEndpointRequest, touchSetupGuard, touchSetupQueue, type TouchNetwork, type TouchSetupQr, type TouchSetupTransport } from "./touch-setup"

export function createNativeTouchSetup(qr: TouchSetupQr, signal: AbortSignal, assertOwner: () => void): TouchSetupTransport {
  const attemptId = crypto.randomUUID()
  const assert = touchSetupGuard(signal, assertOwner)
  const serial = touchSetupQueue(assert)
  const cancel = async () => { await tauriInvoke("touch_setup_cancel", { attemptId }) }
  signal.addEventListener("abort", () => { void cancel().catch(() => undefined) }, { once: true })
  return {
    connect: () => serial(async () => { await tauriInvoke("touch_setup_connect", { attemptId, name: qr.name, pop: qr.pop, serviceUuid: qr.service_uuid }) }),
    scanNetworks: () => serial(async () => await tauriInvoke<TouchNetwork[]>("touch_setup_scan", { attemptId })),
    provision: (network, password) => serial(async () => { await tauriInvoke("touch_setup_provision", { attemptId, ssid: network.ssid, password }) }),
    exchangeEndpoint: (action, userCode) => serial(async () => {
      touchEndpointRequest(action, userCode)
      const response = await tauriInvoke<string>("touch_setup_exchange", { attemptId, action, userCode: userCode ?? null })
      return parseTouchGrant(new TextEncoder().encode(response))
    }),
    cancel,
  }
}
