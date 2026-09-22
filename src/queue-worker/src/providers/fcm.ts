import type { PushNotificationPayload } from "../notification-payload"
import type { PushProviderResult } from "./apns"
import {
  PushProviderError,
  runPushProviderStage,
} from "./diagnostics"

export interface FcmConfig {
  projectId: string
  clientEmail: string
  privateKey: string
}

export const FCM_ANDROID_ANALYTICS_LABEL = "alook_chat_notification_v1"

const FCM_SEND_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
const FCM_DATA_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
const FCM_DATA_PAGE_SIZE = 1_000
const FCM_DATA_MAX_PAGES = 10

type Percentages = Record<string, number>

interface FcmAndroidDeliveryData {
  date: string
  countMessagesAccepted?: string
  countNotificationsAccepted?: string
  messageOutcomePercents?: Percentages
  deliveryPerformancePercents?: Percentages
  messageInsightPercents?: Percentages
  proxyNotificationInsightPercents?: Percentages
}

export interface FcmAndroidDeliveryDataResult {
  rows: FcmAndroidDeliveryData[]
  pageCount: number
  discardedRowCount: number
}

function base64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : new Uint8Array(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_")
}

function pemToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\\n/gu, "\n")
  const encoded = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/gu, "")
    .replace(/-----END PRIVATE KEY-----/gu, "")
    .replace(/\s+/gu, "")
  const binary = atob(encoded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function createFcmServiceAccountAssertion(
  config: Pick<FcmConfig, "clientEmail" | "privateKey">,
  scope: string,
  now = Date.now(),
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const issuedAt = Math.floor(now / 1000)
  const claims = base64Url(JSON.stringify({
    iss: config.clientEmail,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  }))
  const signingInput = `${header}.${claims}`
  const key = await runPushProviderStage("fcm", "key_import", async () => (
    crypto.subtle.importKey(
      "pkcs8",
      pemToBytes(config.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    )
  ))
  const signature = await runPushProviderStage("fcm", "sign", async () => (
    crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    )
  ))
  return `${signingInput}.${base64Url(signature)}`
}

type FcmTokenDependencies = {
  fetch: typeof fetch
  createAssertion: typeof createFcmServiceAccountAssertion
}

async function createGoogleAccessToken(
  config: FcmConfig,
  scope: string,
  dependencies: FcmTokenDependencies = {
    fetch: (...args) => fetch(...args),
    createAssertion: createFcmServiceAccountAssertion,
  },
): Promise<string> {
  const assertion = await runPushProviderStage("fcm", "sign", async () => (
    dependencies.createAssertion(config, scope)
  ))
  const response = await runPushProviderStage("fcm", "oauth_fetch", async () => (
    dependencies.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    })
  ))
  const body = await response.json().catch(() => null) as { access_token?: unknown } | null
  if (!response.ok || typeof body?.access_token !== "string" || !body.access_token) {
    throw new PushProviderError("fcm", "oauth_fetch", response.status, "oauth")
  }
  return body.access_token
}

export async function createFcmAccessToken(
  config: FcmConfig,
  dependencies?: FcmTokenDependencies,
): Promise<string> {
  return createGoogleAccessToken(config, FCM_SEND_SCOPE, dependencies)
}

export async function createFcmDataAccessToken(
  config: FcmConfig,
  dependencies?: FcmTokenDependencies,
): Promise<string> {
  return createGoogleAccessToken(config, FCM_DATA_SCOPE, dependencies)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function projectCount(value: unknown): string | undefined {
  return typeof value === "string" && /^\d+$/u.test(value) ? value : undefined
}

function projectPercentages(
  value: unknown,
  fields: readonly string[],
): Percentages | undefined {
  if (!isRecord(value)) return undefined
  const result: Percentages = {}
  for (const field of fields) {
    const candidate = value[field]
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= 100) {
      result[field] = candidate
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function projectDate(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const { year, month, day } = value
  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || (year as number) < 1
    || (year as number) > 9_999
    || (month as number) < 1
    || (month as number) > 12
    || (day as number) < 1
    || (day as number) > 31
  ) return undefined

  const date = new Date(Date.UTC(year as number, (month as number) - 1, day as number))
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) return undefined
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

const MESSAGE_OUTCOME_FIELDS = [
  "delivered",
  "pending",
  "collapsed",
  "droppedTooManyPendingMessages",
  "droppedAppForceStopped",
  "droppedDeviceInactive",
  "droppedTtlExpired",
] as const
const DELIVERY_PERFORMANCE_FIELDS = [
  "deliveredNoDelay",
  "delayedDeviceOffline",
  "delayedDeviceDoze",
  "delayedMessageThrottled",
  "delayedUserStopped",
] as const
const MESSAGE_INSIGHT_FIELDS = ["priorityLowered"] as const
const PROXY_NOTIFICATION_INSIGHT_FIELDS = [
  "proxied",
  "failed",
  "skippedUnsupported",
  "skippedNotThrottled",
  "skippedUnconfigured",
  "skippedOptedOut",
] as const

function projectDeliveryDataRow(
  value: unknown,
  appId: string,
): FcmAndroidDeliveryData | undefined {
  if (!isRecord(value) || value.appId !== appId || value.analyticsLabel !== FCM_ANDROID_ANALYTICS_LABEL) {
    return undefined
  }
  const date = projectDate(value.date)
  if (!date || !isRecord(value.data)) return undefined

  const countMessagesAccepted = projectCount(value.data.countMessagesAccepted)
  const countNotificationsAccepted = projectCount(value.data.countNotificationsAccepted)
  const messageOutcomePercents = projectPercentages(
    value.data.messageOutcomePercents,
    MESSAGE_OUTCOME_FIELDS,
  )
  const deliveryPerformancePercents = projectPercentages(
    value.data.deliveryPerformancePercents,
    DELIVERY_PERFORMANCE_FIELDS,
  )
  const messageInsightPercents = projectPercentages(
    value.data.messageInsightPercents,
    MESSAGE_INSIGHT_FIELDS,
  )
  const proxyNotificationInsightPercents = projectPercentages(
    value.data.proxyNotificationInsightPercents,
    PROXY_NOTIFICATION_INSIGHT_FIELDS,
  )
  if (
    countMessagesAccepted === undefined
    && countNotificationsAccepted === undefined
    && messageOutcomePercents === undefined
    && deliveryPerformancePercents === undefined
    && messageInsightPercents === undefined
    && proxyNotificationInsightPercents === undefined
  ) return undefined

  return {
    date,
    ...(countMessagesAccepted === undefined ? {} : { countMessagesAccepted }),
    ...(countNotificationsAccepted === undefined ? {} : { countNotificationsAccepted }),
    ...(messageOutcomePercents === undefined ? {} : { messageOutcomePercents }),
    ...(deliveryPerformancePercents === undefined ? {} : { deliveryPerformancePercents }),
    ...(messageInsightPercents === undefined ? {} : { messageInsightPercents }),
    ...(proxyNotificationInsightPercents === undefined ? {} : { proxyNotificationInsightPercents }),
  }
}

export async function listFcmAndroidDeliveryData(
  input: {
    projectId: string
    appId: string
    accessToken: string
  },
  fetchImpl: typeof fetch = fetch,
): Promise<FcmAndroidDeliveryDataResult> {
  const rows: FcmAndroidDeliveryData[] = []
  const seenPageTokens = new Set<string>()
  let discardedRowCount = 0
  let pageToken: string | undefined

  for (let pageIndex = 0; pageIndex < FCM_DATA_MAX_PAGES; pageIndex++) {
    const url = new URL(
      `https://fcmdata.googleapis.com/v1beta1/projects/${encodeURIComponent(input.projectId)}/androidApps/${encodeURIComponent(input.appId)}/deliveryData`,
    )
    url.searchParams.set("pageSize", String(FCM_DATA_PAGE_SIZE))
    if (pageToken) url.searchParams.set("pageToken", pageToken)

    const response = await runPushProviderStage("fcm", "delivery_data_fetch", async () => (
      fetchImpl(url, { headers: { authorization: `Bearer ${input.accessToken}` } })
    ))
    if (!response.ok) {
      throw new PushProviderError("fcm", "delivery_data_fetch", response.status, "data_api")
    }
    const body = await runPushProviderStage("fcm", "delivery_data_parse", async () => (
      response.json()
    ))
    if (!isRecord(body)) {
      throw new PushProviderError("fcm", "delivery_data_parse", undefined, "invalid_response")
    }
    const pageRows = body.androidDeliveryData
    if (pageRows !== undefined && !Array.isArray(pageRows)) {
      throw new PushProviderError("fcm", "delivery_data_parse", undefined, "invalid_response")
    }
    for (const candidate of pageRows ?? []) {
      if (isRecord(candidate) && candidate.analyticsLabel !== FCM_ANDROID_ANALYTICS_LABEL) continue
      const projected = projectDeliveryDataRow(candidate, input.appId)
      if (projected) rows.push(projected)
      else discardedRowCount += 1
    }

    const nextPageToken = body.nextPageToken
    if (nextPageToken === undefined || nextPageToken === "") {
      return { rows, pageCount: pageIndex + 1, discardedRowCount }
    }
    if (typeof nextPageToken !== "string" || seenPageTokens.has(nextPageToken)) {
      throw new PushProviderError("fcm", "delivery_data_parse", undefined, "invalid_page_token")
    }
    seenPageTokens.add(nextPageToken)
    pageToken = nextPageToken
  }

  throw new PushProviderError("fcm", "delivery_data_parse", undefined, "page_limit")
}

export async function sendFcmNotification(
  input: {
    providerToken: string
    accessToken: string
    payload: PushNotificationPayload
    config: Pick<FcmConfig, "projectId">
  },
  fetchImpl: typeof fetch = fetch,
): Promise<PushProviderResult> {
  const response = await runPushProviderStage("fcm", "provider_send", async () => fetchImpl(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(input.config.projectId)}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: input.providerToken,
          notification: {
            title: input.payload.title,
            body: input.payload.body,
          },
          data: input.payload.route,
          android: {
            priority: "high",
            collapse_key: input.payload.notificationId,
            notification: {
              tag: input.payload.notificationId,
              sound: "default",
            },
            fcm_options: {
              analytics_label: FCM_ANDROID_ANALYTICS_LABEL,
            },
          },
        },
      }),
    },
  ))
  if (response.ok) return { outcome: "sent" }

  const body = await response.json().catch(() => null) as {
    error?: {
      status?: unknown
      details?: Array<{ errorCode?: unknown }>
    }
  } | null
  const fcmErrorCode = body?.error?.details?.find(
    (detail) => typeof detail?.errorCode === "string",
  )?.errorCode
  const reason = typeof fcmErrorCode === "string"
    ? fcmErrorCode
    : typeof body?.error?.status === "string"
      ? body.error.status
    : "unknown"
  if (
    (response.status === 404 && reason === "UNREGISTERED")
    || (response.status === 400 && reason === "INVALID_ARGUMENT")
  ) {
    return { outcome: "invalid-token" }
  }
  throw new PushProviderError("fcm", "provider_send", response.status, reason)
}
