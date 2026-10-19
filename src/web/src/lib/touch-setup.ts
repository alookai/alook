export const TOUCH_PROVISION_SERVICE = "b4df5a1c-3f6b-f4bf-ea4a-820304901a02"

export type TouchSetupQr = { ver: "v1"; name: string; pop: string; transport: "ble"; security: 1; service_uuid: string }
export type TouchNetwork = { ssid: string; rssi: number; secured: boolean }
export type TouchGrant = { state: "pending" } | { state: "ready"; user_code: string }
export interface TouchSetupTransport {
  connect(): Promise<void>
  scanNetworks(): Promise<TouchNetwork[]>
  provision(network: TouchNetwork, password: string): Promise<void>
  exchangeEndpoint(action: "code" | "ack", userCode?: string): Promise<TouchGrant>
  cancel(): Promise<void>
}

function validTouchCode(code: string) {
  return /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.exec(code)?.[0] === code
}

export function parseTouchSetupQr(text: string): TouchSetupQr {
  if (text.length > 512) throw new Error("This is not a Touch setup code.")
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error("This is not a Touch setup code.") }
  if (!value || typeof value !== "object") throw new Error("This is not a Touch setup code.")
  const qr = value as Record<string, unknown>
  if (qr.ver !== "v1" || qr.transport !== "ble" || qr.security !== 1 || typeof qr.name !== "string" || !/^ALOOK_TOUCH_[0-9A-F]{6}$/.test(qr.name) || typeof qr.pop !== "string" || !/^[0-9a-f]{32}$/.test(qr.pop) || qr.service_uuid !== TOUCH_PROVISION_SERVICE) throw new Error("This is not a supported Touch setup code.")
  return { ver: "v1", name: qr.name, pop: qr.pop, transport: "ble", security: 1, service_uuid: TOUCH_PROVISION_SERVICE }
}

export function parseTouchGrant(bytes: Uint8Array): TouchGrant {
  if (bytes.length > 256) throw new Error("Touch returned an invalid response.")
  let value: unknown
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { throw new Error("Touch returned an invalid response.") }
  if (!value || typeof value !== "object") throw new Error("Touch returned an invalid response.")
  const grant = value as Record<string, unknown>
  if (grant.state === "pending") return { state: "pending" }
  if (grant.state === "ready" && typeof grant.user_code === "string" && validTouchCode(grant.user_code)) return { state: "ready", user_code: grant.user_code }
  throw new Error("Touch returned an invalid response.")
}

export function touchSetupGuard(signal: AbortSignal, assertOwner: () => void) {
  return () => { signal.throwIfAborted(); assertOwner() }
}

export function touchSetupQueue(assert: () => void) {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(async () => { assert(); const value = await operation(); assert(); return value })
    tail = result.catch(() => undefined)
    return result
  }
}

export function touchEndpointRequest(action: "code" | "ack", userCode?: string) {
  if (action === "code") return JSON.stringify({ action })
  if (!userCode || !validTouchCode(userCode)) throw new Error("Touch returned an invalid response.")
  return JSON.stringify({ action, user_code: userCode })
}
