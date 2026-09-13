import { isMobile, isTauri, tauriInvoke } from "@alook/shared"

export type MobileSystemNotificationPermission = "granted" | "denied" | "prompt"

export type MobileSystemNotificationRegistration = {
  installationId: string
  platform: "ios" | "android"
  providerEnvironment: "sandbox" | "production"
  providerToken?: string
  previousProviderToken?: string
  appVersion?: string
}

export type MobileSystemNotificationActivation = {
  notificationId: string
  messageId: string
  targetId: string
}

export type MobileSystemNotificationDestination = {
  href: string
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 60_000] as const
let registrationMutationTail: Promise<void> = Promise.resolve()
let registrationSuppressed = false

function serializeRegistrationMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = registrationMutationTail.then(operation, operation)
  registrationMutationTail = result.then(() => undefined, () => undefined)
  return result
}

export function suspendMobileSystemNotificationRegistration() {
  registrationSuppressed = true
}

export function resumeMobileSystemNotificationRegistration() {
  registrationSuppressed = false
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value)
}

function isProviderToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 16
    && value.length <= 4096
    && !/\p{Cc}/u.test(value)
}

function optionalString(
  value: unknown,
  validate: (candidate: unknown) => candidate is string,
): string | undefined | false {
  if (value === null || value === undefined) return undefined
  return validate(value) ? value : false
}

export function parseMobileSystemNotificationPermission(
  value: unknown,
): MobileSystemNotificationPermission | null {
  if (!isObject(value) || !hasExactKeys(value, ["permissionState"])) return null
  return value.permissionState === "granted"
    || value.permissionState === "denied"
    || value.permissionState === "prompt"
    ? value.permissionState
    : null
}

export function parseMobileSystemNotificationRegistration(
  value: unknown,
): MobileSystemNotificationRegistration | null {
  if (!isObject(value) || !hasExactKeys(value, [
    "installationId",
    "platform",
    "providerEnvironment",
    "providerToken",
    "previousProviderToken",
    "appVersion",
  ])) return null
  if (typeof value.installationId !== "string" || !UUID.test(value.installationId)) return null
  if (value.platform !== "ios" && value.platform !== "android") return null
  if (value.providerEnvironment !== "sandbox" && value.providerEnvironment !== "production") return null
  if (value.platform === "android" && value.providerEnvironment !== "production") return null

  const providerToken = optionalString(value.providerToken, isProviderToken)
  const previousProviderToken = optionalString(value.previousProviderToken, isProviderToken)
  const appVersion = optionalString(
    value.appVersion,
    (candidate): candidate is string => typeof candidate === "string"
      && candidate.length >= 1
      && candidate.length <= 128,
  )
  if (providerToken === false || previousProviderToken === false || appVersion === false) return null
  if (providerToken !== undefined && providerToken === previousProviderToken) return null

  return {
    installationId: value.installationId.toLowerCase(),
    platform: value.platform,
    providerEnvironment: value.providerEnvironment,
    ...(providerToken === undefined ? {} : { providerToken }),
    ...(previousProviderToken === undefined ? {} : { previousProviderToken }),
    ...(appVersion === undefined ? {} : { appVersion }),
  }
}

export function parseMobileSystemNotificationActivation(
  value: unknown,
): MobileSystemNotificationActivation | null {
  if (!isObject(value) || !hasExactKeys(value, ["notificationId", "messageId", "targetId"])) {
    return null
  }
  if (typeof value.notificationId !== "string" || !UUID.test(value.notificationId)) return null
  if (!isSafeId(value.messageId) || !isSafeId(value.targetId)) return null
  return {
    notificationId: value.notificationId.toLowerCase(),
    messageId: value.messageId,
    targetId: value.targetId,
  }
}

async function permissionCommand(
  command: "mobile_system_notification_check_permission" | "mobile_system_notification_request_permission",
): Promise<MobileSystemNotificationPermission> {
  const permission = parseMobileSystemNotificationPermission(await tauriInvoke<unknown>(command))
  if (!permission) throw new Error("invalid_native_response")
  return permission
}

export function checkMobileSystemNotificationPermission(): Promise<MobileSystemNotificationPermission> {
  return permissionCommand("mobile_system_notification_check_permission")
}

export function requestMobileSystemNotificationPermission(): Promise<MobileSystemNotificationPermission> {
  return permissionCommand("mobile_system_notification_request_permission")
}

export async function snapshotMobileSystemNotificationRegistration(): Promise<MobileSystemNotificationRegistration> {
  const snapshot = parseMobileSystemNotificationRegistration(
    await tauriInvoke<unknown>("mobile_system_notification_snapshot"),
  )
  if (!snapshot) throw new Error("invalid_native_response")
  return snapshot
}

export async function acknowledgeMobileSystemNotificationRegistration(
  providerToken: string,
): Promise<void> {
  if (!isProviderToken(providerToken)) throw new Error("invalid_provider_token")
  await tauriInvoke("mobile_system_notification_acknowledge_registration", { providerToken })
}

type TauriChannel = { onmessage: (value: unknown) => void }
type TauriWindow = Window & {
  __TAURI__?: { core?: { Channel?: new () => TauriChannel } }
}

export async function listenMobileSystemNotificationSignals(
  ready: () => void,
): Promise<() => void> {
  const Channel = (window as TauriWindow).__TAURI__?.core?.Channel
  if (!Channel) throw new Error("native_bridge_unavailable")
  const channel = new Channel()
  channel.onmessage = () => ready()
  const registrationId = await tauriInvoke<number>("mobile_system_notification_listen", { channel })
  if (!Number.isSafeInteger(registrationId) || registrationId < 0) {
    throw new Error("invalid_native_response")
  }
  return () => {
    void tauriInvoke("mobile_system_notification_unlisten", { registrationId }).catch(() => undefined)
  }
}

export async function takeMobileSystemNotificationActivation(): Promise<MobileSystemNotificationActivation | null> {
  const value = await tauriInvoke<unknown>("mobile_system_notification_take_activation")
  if (value === null || value === undefined) return null
  const activation = parseMobileSystemNotificationActivation(value)
  if (!activation) throw new Error("invalid_native_response")
  return activation
}

export async function postMobileSystemNotificationRegistration(
  snapshot: MobileSystemNotificationRegistration,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!snapshot.providerToken) throw new Error("provider_token_unavailable")
  await serializeRegistrationMutation(async () => {
    if (registrationSuppressed) throw new Error("registration_suspended")
    const response = await fetchImpl("/api/community/notifications/devices", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installationId: snapshot.installationId,
        platform: snapshot.platform,
        providerEnvironment: snapshot.providerEnvironment,
        providerToken: snapshot.providerToken,
        ...(snapshot.previousProviderToken
          ? { previousProviderToken: snapshot.previousProviderToken }
          : {}),
        ...(snapshot.appVersion ? { appVersion: snapshot.appVersion } : {}),
      }),
    })
    if (!response.ok) throw new Error("registration_failed")
  })
}

export async function deleteMobileSystemNotificationRegistration(
  installationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!UUID.test(installationId)) throw new Error("invalid_installation_id")
  await serializeRegistrationMutation(async () => {
    const response = await fetchImpl(
      `/api/community/notifications/devices/${encodeURIComponent(installationId)}`,
      { method: "DELETE", credentials: "same-origin" },
    )
    if (!response.ok) throw new Error("unregistration_failed")
  })
}

export async function unregisterCurrentMobileSystemNotification(
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!isTauri() || !isMobile()) return
  const snapshot = await snapshotMobileSystemNotificationRegistration()
  await deleteMobileSystemNotificationRegistration(snapshot.installationId, fetchImpl)
}

export type MobileSystemNotificationRegistrationDeps = {
  checkPermission: () => Promise<MobileSystemNotificationPermission>
  requestPermission: () => Promise<MobileSystemNotificationPermission>
  snapshot: () => Promise<MobileSystemNotificationRegistration>
  register: (snapshot: MobileSystemNotificationRegistration) => Promise<void>
  acknowledge: (providerToken: string) => Promise<void>
  unregister: (installationId: string) => Promise<void>
  schedule: (callback: () => void, delayMs: number) => unknown
  cancel: (handle: unknown) => void
  retryDelaysMs?: readonly number[]
}

export function createMobileSystemNotificationRegistrationController(
  deps: MobileSystemNotificationRegistrationDeps,
) {
  let disposed = false
  let active: Promise<void> | null = null
  let rerun = false
  let pendingPrompt = false
  let retryAttempt = 0
  let retryTimer: unknown | undefined

  function clearRetry() {
    if (retryTimer === undefined) return
    deps.cancel(retryTimer)
    retryTimer = undefined
  }

  function scheduleRetry(allowPrompt: boolean) {
    if (disposed || retryTimer !== undefined) return
    const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS
    const delay = delays[retryAttempt]
    if (delay === undefined) return
    retryAttempt += 1
    retryTimer = deps.schedule(() => {
      retryTimer = undefined
      void sync(allowPrompt)
    }, delay)
  }

  async function runOnce(allowPrompt: boolean) {
    let permission = await deps.checkPermission()
    if (permission === "prompt" && allowPrompt) {
      permission = await deps.requestPermission()
    }
    if (permission === "prompt") return

    const snapshot = await deps.snapshot()
    if (permission === "denied") {
      await deps.unregister(snapshot.installationId)
      return
    }
    if (!snapshot.providerToken) return
    const providerToken = snapshot.providerToken
    await deps.register(snapshot)
    await deps.acknowledge(providerToken)
  }

  function sync(allowPrompt = false): Promise<void> {
    if (disposed) return Promise.resolve()
    pendingPrompt ||= allowPrompt
    rerun = true
    clearRetry()
    if (active) return active

    active = (async () => {
      while (rerun && !disposed) {
        rerun = false
        const promptThisRun = pendingPrompt
        pendingPrompt = false
        try {
          await runOnce(promptThisRun)
          retryAttempt = 0
        } catch {
          if (rerun) {
            pendingPrompt ||= promptThisRun
            continue
          }
          scheduleRetry(promptThisRun)
        }
      }
    })().finally(() => {
      active = null
    })
    return active
  }

  return {
    sync,
    dispose() {
      if (disposed) return
      disposed = true
      clearRetry()
    },
  }
}

export type MobileSystemNotificationActivationDeps = {
  take: () => Promise<MobileSystemNotificationActivation | null>
  revalidate: (
    activation: MobileSystemNotificationActivation,
  ) => Promise<MobileSystemNotificationDestination | null>
  navigate: (href: string) => void
  openInbox: () => Promise<void> | void
}

export function createMobileSystemNotificationActivationController(
  deps: MobileSystemNotificationActivationDeps,
) {
  let disposed = false
  let draining = false
  let rerun = false

  async function drain() {
    if (disposed) return
    if (draining) {
      rerun = true
      return
    }
    draining = true
    try {
      do {
        rerun = false
        let activation: MobileSystemNotificationActivation | null
        try {
          activation = await deps.take()
        } catch {
          if (!disposed) await deps.openInbox()
          continue
        }
        if (!activation || disposed) continue
        const destination = await deps.revalidate(activation).catch(() => null)
        if (disposed) continue
        if (destination) deps.navigate(destination.href)
        else await deps.openInbox()
      } while (rerun && !disposed)
    } finally {
      draining = false
    }
  }

  return {
    drain,
    dispose() {
      disposed = true
    },
  }
}

type SurfaceKind = "channel" | "forum" | "thread" | "dm"

function surfaceReceipt(value: unknown): { channelId: string; surfaceKind: SurfaceKind } | null {
  if (!isObject(value) || !hasExactKeys(value, ["channelId", "surfaceKind"])) return null
  if (!isSafeId(value.channelId)) return null
  if (value.surfaceKind !== "channel"
    && value.surfaceKind !== "forum"
    && value.surfaceKind !== "thread"
    && value.surfaceKind !== "dm") return null
  return { channelId: value.channelId, surfaceKind: value.surfaceKind }
}

export async function revalidateMobileSystemNotificationActivation(
  activation: MobileSystemNotificationActivation,
  fetchImpl: typeof fetch = fetch,
): Promise<MobileSystemNotificationDestination | null> {
  try {
    const messageResponse = await fetchImpl(
      `/api/community/channels/${encodeURIComponent(activation.targetId)}/messages?anchor=${encodeURIComponent(activation.messageId)}&limit=1`,
      { method: "GET", credentials: "same-origin", cache: "no-store" },
    )
    if (!messageResponse.ok) return null
    const messagePayload: unknown = await messageResponse.json()
    if (!isObject(messagePayload) || !Array.isArray(messagePayload.messages)) return null
    const receipt = surfaceReceipt(messagePayload.surfaceReceipt)
    if (!receipt || receipt.channelId !== activation.targetId) return null
    const message = messagePayload.messages.find((candidate) => (
      isObject(candidate)
      && candidate.id === activation.messageId
      && typeof candidate.seq === "number"
      && Number.isSafeInteger(candidate.seq)
      && candidate.seq > 0
    ))
    if (!isObject(message) || typeof message.seq !== "number") return null

    if (receipt.surfaceKind === "dm") {
      return {
        href: `/c/me/${encodeURIComponent(activation.targetId)}?seq=${message.seq}`,
      }
    }

    const channelResponse = await fetchImpl(
      `/api/community/channels/${encodeURIComponent(activation.targetId)}`,
      { method: "GET", credentials: "same-origin", cache: "no-store" },
    )
    if (!channelResponse.ok) return null
    const channel: unknown = await channelResponse.json()
    if (!isObject(channel)
      || channel.id !== activation.targetId
      || !isSafeId(channel.serverId)
      || (channel.type !== "text" && channel.type !== "forum" && channel.type !== "thread")) {
      return null
    }
    const expectedType = receipt.surfaceKind === "channel" ? "text" : receipt.surfaceKind
    if (channel.type !== expectedType) return null
    return {
      href: `/c/channels/${encodeURIComponent(channel.serverId)}/${encodeURIComponent(activation.targetId)}?msg=${encodeURIComponent(activation.messageId)}`,
    }
  } catch {
    return null
  }
}
