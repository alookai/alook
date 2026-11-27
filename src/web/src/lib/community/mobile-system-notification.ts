import { createNotificationActivationDrain } from "./notification-activation-drain"
import { NOTIFICATION_UUID_RE } from "./system-notification-route"
import { COMMUNITY_CONTRACT_HEADER, BUSINESS_SCHEMA_VERSION, isMobile, isTauri, tauriInvoke } from "@alook/shared"
import { SESSION_ACCOUNT_HEADER } from "@/lib/session-account"
import { createStore } from "@tanstack/store"
import { QueryClient } from "@tanstack/react-query"

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
  viewerUserId?: string
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const UUID = NOTIFICATION_UUID_RE
const PENDING_UNREGISTRATION_STORAGE_KEY = "alook:mobile-push-pending-unregister:v1"
const registrationClient = new QueryClient()
const registrationPolicy = createStore({ suppressed: false })

export type PendingMobilePushUnregistration = {
  installationId?: string
  queuedAt: number
}

function getPendingStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null
  } catch {
    return null
  }
}

export function readPendingMobileSystemNotificationUnregistration(): PendingMobilePushUnregistration | null {
  const storage = getPendingStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(PENDING_UNREGISTRATION_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed) || typeof parsed.queuedAt !== "number" || !Number.isFinite(parsed.queuedAt)) {
      return null
    }
    const installationId = parsed.installationId
    if (installationId !== undefined) {
      if (typeof installationId !== "string" || !UUID.test(installationId)) return null
      return { installationId: installationId.toLowerCase(), queuedAt: parsed.queuedAt }
    }
    return { queuedAt: parsed.queuedAt }
  } catch {
    return null
  }
}

export function queuePendingMobileSystemNotificationUnregistration(installationId?: string): void {
  if (!isTauri() || !isMobile()) return
  const storage = getPendingStorage()
  if (!storage) return
  const normalizedId = installationId && UUID.test(installationId)
    ? installationId.toLowerCase()
    : readPendingMobileSystemNotificationUnregistration()?.installationId
  const entry: PendingMobilePushUnregistration = {
    ...(normalizedId ? { installationId: normalizedId } : {}),
    queuedAt: Date.now(),
  }
  try {
    storage.setItem(PENDING_UNREGISTRATION_STORAGE_KEY, JSON.stringify(entry))
  } catch {
    // Best-effort persistence when storage is blocked.
  }
}

export function clearPendingMobileSystemNotificationUnregistration(installationId?: string): void {
  const storage = getPendingStorage()
  if (!storage) return
  try {
    if (installationId) {
      const existing = readPendingMobileSystemNotificationUnregistration()
      if (existing?.installationId && existing.installationId !== installationId.toLowerCase()) {
        return
      }
    }
    storage.removeItem(PENDING_UNREGISTRATION_STORAGE_KEY)
  } catch {
    // Ignore storage removal errors.
  }
}

function serializeRegistrationMutation<T>(operation: () => Promise<T>): Promise<T> {
  return registrationClient.getMutationCache().build<T, Error, () => Promise<T>, unknown>(registrationClient, { mutationKey: ["native", "notification-registration"], scope: { id: "native-notification-registration" }, gcTime: 0, mutationFn: (run) => run() }).execute(operation)
}

export function suspendMobileSystemNotificationRegistration() {
  registrationPolicy.setState(() => ({ suppressed: true }))
}

export function resumeMobileSystemNotificationRegistration() {
  registrationPolicy.setState(() => ({ suppressed: false }))
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
  if (
    !isObject(value)
    || !(
      hasExactKeys(value, ["notificationId", "messageId", "targetId"])
      || hasExactKeys(value, ["notificationId", "messageId", "targetId", "viewerUserId"])
    )
  ) {
    return null
  }
  if (typeof value.notificationId !== "string" || !UUID.test(value.notificationId)) return null
  if (!isSafeId(value.messageId) || !isSafeId(value.targetId)) return null
  const viewerUserId = optionalString(value.viewerUserId, isSafeId)
  if (viewerUserId === false) return null
  return {
    notificationId: value.notificationId.toLowerCase(),
    messageId: value.messageId,
    targetId: value.targetId,
    ...(viewerUserId === undefined ? {} : { viewerUserId }),
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

export async function peekMobileSystemNotificationActivation(): Promise<MobileSystemNotificationActivation | null> {
  const value = await tauriInvoke<unknown>("mobile_system_notification_peek_activation")
  if (value === null || value === undefined) return null
  const activation = parseMobileSystemNotificationActivation(value)
  if (!activation) throw new Error("invalid_native_response")
  return activation
}

export async function ackMobileSystemNotificationActivation(notificationId: string): Promise<void> {
  if (!UUID.test(notificationId)) throw new Error("invalid_notification_id")
  await tauriInvoke("mobile_system_notification_ack_activation", { notificationId })
}

export async function clearMobileSystemNotificationsForViewer(viewerUserId: string): Promise<void> {
  if (!isTauri() || !isMobile()) return
  if (!isSafeId(viewerUserId)) throw new Error("invalid_viewer_user_id")
  await tauriInvoke("mobile_system_notification_clear_viewer", { viewerUserId })
}

export async function dismissMobileSystemNotification(notificationId: string): Promise<void> {
  if (!UUID.test(notificationId)) throw new Error("invalid_notification_id")
  await tauriInvoke("mobile_system_notification_dismiss", { notificationId })
}

export async function dismissMobileSystemNotificationConversation(
  viewerUserId: string,
  targetId: string,
): Promise<void> {
  if (!isSafeId(viewerUserId)) throw new Error("invalid_viewer_user_id")
  if (!isSafeId(targetId)) throw new Error("invalid_target_id")
  await tauriInvoke("mobile_system_notification_dismiss_conversation", { viewerUserId, targetId })
}

export async function postMobileSystemNotificationRegistration(
  snapshot: MobileSystemNotificationRegistration,
  fetchImpl: typeof fetch = fetch,
  options: { signal?: AbortSignal; assertActive?: () => void; accountId?: string } = {},
): Promise<void> {
  if (!snapshot.providerToken) throw new Error("provider_token_unavailable")
  await serializeRegistrationMutation(async () => {
    options.assertActive?.()
    if (registrationPolicy.get().suppressed) throw new Error("registration_suspended")
    const response = await fetchImpl("/api/community/notifications/devices", {
      method: "POST",
      signal: options.signal,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION),
        ...(options.accountId ? { [SESSION_ACCOUNT_HEADER]: options.accountId } : {}),
      },
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
    options.assertActive?.()
    if (!response.ok) throw new Error("registration_failed")
  })
}

export type MobileSystemNotificationUnregistrationProof = {
  providerToken?: string
  previousProviderToken?: string
}

export async function deleteMobileSystemNotificationRegistration(
  installationId: string,
  fetchImpl: typeof fetch = fetch,
  options: {
    signal?: AbortSignal
    assertActive?: () => void
    accountId?: string
    providerToken?: string
    previousProviderToken?: string
  } = {},
): Promise<void> {
  if (!UUID.test(installationId)) throw new Error("invalid_installation_id")
  await serializeRegistrationMutation(async () => {
    options.assertActive?.()
    const validProviderToken = options.providerToken && isProviderToken(options.providerToken)
      ? options.providerToken
      : undefined
    const validPreviousToken = options.previousProviderToken && isProviderToken(options.previousProviderToken)
      ? options.previousProviderToken
      : undefined
    const proofBody = validProviderToken || validPreviousToken
      ? JSON.stringify({
          ...(validProviderToken ? { providerToken: validProviderToken } : {}),
          ...(validPreviousToken ? { previousProviderToken: validPreviousToken } : {}),
        })
      : undefined
    const response = await fetchImpl(
      `/api/community/notifications/devices/${encodeURIComponent(installationId)}`,
      {
        method: "DELETE",
        credentials: "same-origin",
        signal: options.signal,
        headers: {
          [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION),
          ...(options.accountId ? { [SESSION_ACCOUNT_HEADER]: options.accountId } : {}),
          ...(proofBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(proofBody ? { body: proofBody } : {}),
      },
    )
    options.assertActive?.()
    if (!response.ok) throw new Error("unregistration_failed")
  })
}

export async function unregisterCurrentMobileSystemNotification(
  fetchImpl: typeof fetch = fetch,
  options: { signal?: AbortSignal; assertActive?: () => void; accountId?: string } = {},
): Promise<string | undefined> {
  if (!isTauri() || !isMobile()) return undefined
  options.assertActive?.()
  let snapshot: MobileSystemNotificationRegistration
  try {
    snapshot = await snapshotMobileSystemNotificationRegistration()
  } catch (error) {
    queuePendingMobileSystemNotificationUnregistration()
    throw error
  }
  options.assertActive?.()
  try {
    await deleteMobileSystemNotificationRegistration(snapshot.installationId, fetchImpl, {
      ...options,
      providerToken: snapshot.providerToken,
      previousProviderToken: snapshot.previousProviderToken,
    })
    clearPendingMobileSystemNotificationUnregistration(snapshot.installationId)
    return snapshot.installationId
  } catch (error) {
    queuePendingMobileSystemNotificationUnregistration(snapshot.installationId)
    throw error
  }
}

export type MobileSystemNotificationRegistrationDeps = {
  checkPermission: () => Promise<MobileSystemNotificationPermission>
  requestPermission: () => Promise<MobileSystemNotificationPermission>
  snapshot: () => Promise<MobileSystemNotificationRegistration>
  register: (snapshot: MobileSystemNotificationRegistration) => Promise<void>
  acknowledge: (providerToken: string) => Promise<void>
  unregister: (
    installationId: string,
    proof?: MobileSystemNotificationUnregistrationProof,
  ) => Promise<void>
  readPendingUnregistration?: () => PendingMobilePushUnregistration | null
  clearPendingUnregistration?: (installationId?: string) => void
}

function extractUnregistrationProof(
  snapshot: MobileSystemNotificationRegistration,
): MobileSystemNotificationUnregistrationProof | undefined {
  if (!snapshot.providerToken && !snapshot.previousProviderToken) return undefined
  return {
    ...(snapshot.providerToken ? { providerToken: snapshot.providerToken } : {}),
    ...(snapshot.previousProviderToken ? { previousProviderToken: snapshot.previousProviderToken } : {}),
  }
}

export function createMobileSystemNotificationRegistrationController(
  deps: MobileSystemNotificationRegistrationDeps,
) {
    const protocol = createStore({ disposed: false, active: null as Promise<void> | null, rerun: false, pendingPrompt: false });
    async function runOnce(allowPrompt: boolean) {
        const assert = () => { if (protocol.get().disposed) throw new DOMException("Retired notification registration", "AbortError") }
        assert()
        const pending = deps.readPendingUnregistration?.() ?? null
        let cachedSnapshot: MobileSystemNotificationRegistration | undefined
        if (pending) {
            cachedSnapshot = await deps.snapshot()
            assert()
            const targetInstallationId = pending.installationId ?? cachedSnapshot.installationId
            const proof = targetInstallationId === cachedSnapshot.installationId
                ? extractUnregistrationProof(cachedSnapshot)
                : undefined
            await deps.unregister(targetInstallationId, proof)
            assert()
            deps.clearPendingUnregistration?.(targetInstallationId)
        }
        let permission = await deps.checkPermission();
        assert()
        if (permission === "prompt" && allowPrompt) {
            permission = await deps.requestPermission();
            assert()
        }
        if (permission === "prompt")
            return;
        const snapshot = cachedSnapshot ?? await deps.snapshot();
        assert()
        if (permission === "denied") {
            await deps.unregister(snapshot.installationId, extractUnregistrationProof(snapshot));
            return;
        }
        if (!snapshot.providerToken)
            return;
        const providerToken = snapshot.providerToken;
        await deps.register(snapshot);
        assert()
        await deps.acknowledge(providerToken);
    }
    function sync(allowPrompt = false): Promise<void> {
        if (protocol.get().disposed)
            return Promise.resolve();
        protocol.setState(state => ({ ...state, pendingPrompt: protocol.get().pendingPrompt || allowPrompt }));
        protocol.setState(state => ({ ...state, rerun: true }));
        const inFlight = protocol.get().active
        if (inFlight) return inFlight
        const active = Promise.resolve().then(async () => {
                while (protocol.get().rerun && !protocol.get().disposed) {
                    protocol.setState(state => ({ ...state, rerun: false }));
                    const promptThisRun = protocol.get().pendingPrompt;
                    protocol.setState(state => ({ ...state, pendingPrompt: false }));
                    try {
                        await runOnce(promptThisRun);
                    }
                    catch {
                        if (protocol.get().rerun) {
                            protocol.setState(state => ({ ...state, pendingPrompt: protocol.get().pendingPrompt || promptThisRun }));
                            continue;
                        }
                    }
                }
            }).finally(() => {
                protocol.setState(state => ({ ...state, active: null }));
            });
        protocol.setState(state => ({ ...state, active }));
        return protocol.get().active!;
    }
    return {
        sync,
        dispose() {
            if (protocol.get().disposed)
                return;
            protocol.setState(state => ({ ...state, disposed: true }));
        },
    };
}

export type MobileSystemNotificationActivationDeps = {
  peek: () => Promise<MobileSystemNotificationActivation | null>
  ack?: (notificationId: string) => Promise<void>
  expectedViewerUserId?: string
  resolveHref?: (activation: MobileSystemNotificationActivation) => string | undefined
  queueDismiss: (notificationId: string, href: string, targetId?: string) => void
  navigate: (href: string) => void
}

export function createMobileSystemNotificationActivationController(
  deps: MobileSystemNotificationActivationDeps,
) {
  const activation = createNotificationActivationDrain({
    peek: () => deps.peek(),
    ack: deps.ack,
    expectedViewerUserId: deps.expectedViewerUserId,
    hrefFor: (value) => deps.resolveHref?.(value) ?? mobileSystemNotificationHref(value),
    targetIdFor: (value) => value.targetId,
    queueDismiss: (id, href, targetId) => deps.queueDismiss(id, href, targetId),
    navigate: (href) => deps.navigate(href),
  })
  return { drain: activation.drain, dispose: activation.dispose }
}

export function mobileSystemNotificationHref(activation: MobileSystemNotificationActivation): string {
  return `/c/messages/${encodeURIComponent(activation.messageId)}`
}
