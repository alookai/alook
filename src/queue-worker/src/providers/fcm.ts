import type { PushNotificationPayload } from "../notification-payload"
import { base64Url, pemToBytes, type PushProviderResult } from "./token-encoding"
import {
  PushProviderError,
  runPushProviderStage,
} from "./diagnostics"

export interface FcmConfig {
  projectId: string
  clientEmail: string
  privateKey: string
}

type FcmTokenConfig = Pick<FcmConfig, "clientEmail" | "privateKey">

const FCM_ACCESS_TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000
const FCM_ACCESS_TOKEN_DEFAULT_TTL_MS = 60 * 60 * 1000

function mobilePushNotificationTag(
  viewerUserId: string,
  targetId: string,
  notificationId: string,
): string {
  return `alook:v2:${viewerUserId}:${targetId}:${notificationId}`
}


async function createFcmServiceAccountAssertion(
  config: FcmTokenConfig,
  now = Date.now(),
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const issuedAt = Math.floor(now / 1000)
  const claims = base64Url(JSON.stringify({
    iss: config.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
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

async function createFcmCredentialFingerprint(config: FcmTokenConfig): Promise<string> {
  return runPushProviderStage("fcm", "credential_fingerprint", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify([
      config.clientEmail,
      base64Url(pemToBytes(config.privateKey)),
    ]))
    return base64Url(await crypto.subtle.digest("SHA-256", encoded))
  })
}

type FcmTokenDependencies = {
  fetch: typeof fetch
  createAssertion: typeof createFcmServiceAccountAssertion
}

type FcmAccessTokenGrant = {
  token: string
  ttlMs?: number
}

async function exchangeFcmAccessToken(
  config: FcmTokenConfig,
  dependencies: FcmTokenDependencies = {
    fetch: (...args) => fetch(...args),
    createAssertion: createFcmServiceAccountAssertion,
  },
  now = Date.now(),
): Promise<{ token: string; ttlMs: number }> {
  const assertion = await runPushProviderStage("fcm", "sign", async () => (
    dependencies.createAssertion(config, now)
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
  const body = await response.json().catch(() => null) as {
    access_token?: unknown
    expires_in?: unknown
  } | null
  if (!response.ok || typeof body?.access_token !== "string" || !body.access_token) {
    throw new PushProviderError("fcm", "oauth_fetch", response.status, "oauth")
  }
  const rawExpiresIn = body.expires_in
  const ttlMs = typeof rawExpiresIn === "number" && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
    ? Math.min(Math.floor(rawExpiresIn * 1000), FCM_ACCESS_TOKEN_DEFAULT_TTL_MS)
    : FCM_ACCESS_TOKEN_DEFAULT_TTL_MS
  return { token: body.access_token, ttlMs }
}

export async function createFcmAccessToken(
  config: FcmConfig,
  dependencies: FcmTokenDependencies = {
    fetch: (...args) => fetch(...args),
    createAssertion: createFcmServiceAccountAssertion,
  },
): Promise<string> {
  const { token } = await exchangeFcmAccessToken(config, dependencies)
  return token
}

type FcmAccessTokenProviderDependencies = {
  createAccessToken: (
    config: FcmTokenConfig,
    now: number,
  ) => Promise<string | FcmAccessTokenGrant>
  createFingerprint: typeof createFcmCredentialFingerprint
  now: () => number
}

type CachedFcmAccessToken = {
  issuedAtEpochMs: number
  token: string
  refreshIntervalMs: number
  expirationIntervalMs: number
}

type FcmAccessTokenFlight = {
  promise: Promise<CachedFcmAccessToken>
  startedAtEpochMs: number
}

type FcmAccessTokenEntry = {
  cached?: CachedFcmAccessToken
  inFlight?: FcmAccessTokenFlight
}

function accessTokenAge(now: number, issuedAtEpochMs: number): number {
  return Math.max(0, now - issuedAtEpochMs)
}

function resolveFcmTokenLifetime(ttlMs?: number): {
  refreshIntervalMs: number
  expirationIntervalMs: number
} {
  const expirationIntervalMs = typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0
    ? Math.min(Math.floor(ttlMs), FCM_ACCESS_TOKEN_DEFAULT_TTL_MS)
    : FCM_ACCESS_TOKEN_DEFAULT_TTL_MS
  const refreshMarginMs = Math.min(
    FCM_ACCESS_TOKEN_REFRESH_MARGIN_MS,
    Math.ceil(expirationIntervalMs / 6),
  )
  return {
    refreshIntervalMs: Math.max(0, expirationIntervalMs - refreshMarginMs),
    expirationIntervalMs,
  }
}

/**
 * Keep one OAuth access-token entry per service-account credential in the
 * isolate. Refreshing 10 minutes before expiry (at 50 minutes for a standard
 * 1-hour grant) avoids per-push RSA signing and OAuth round-trips while
 * single-flighting concurrent refreshes per credential.
 */
export function createFcmAccessTokenProvider(
  overrides: Partial<FcmAccessTokenProviderDependencies> = {},
): (config: FcmTokenConfig) => Promise<string> {
  const dependencies: FcmAccessTokenProviderDependencies = {
    createAccessToken: (config, now) => exchangeFcmAccessToken(config, undefined, now),
    createFingerprint: createFcmCredentialFingerprint,
    now: Date.now,
    ...overrides,
  }
  const entryByCredential = new Map<string, FcmAccessTokenEntry>()

  function pruneExpiredEntries(now: number): void {
    for (const [credentialFingerprint, entry] of entryByCredential) {
      if (entry.inFlight) continue
      if (
        !entry.cached
        || accessTokenAge(now, entry.cached.issuedAtEpochMs) >= entry.cached.expirationIntervalMs
      ) {
        entryByCredential.delete(credentialFingerprint)
      }
    }
  }

  async function settleFlight(
    credentialFingerprint: string,
    entry: FcmAccessTokenEntry,
    flight: FcmAccessTokenFlight,
  ): Promise<string> {
    try {
      const granted = await flight.promise
      if (entryByCredential.get(credentialFingerprint) === entry && entry.inFlight === flight) {
        entry.cached = granted
        entry.inFlight = undefined
      }
      return granted.token
    } catch (error) {
      if (entryByCredential.get(credentialFingerprint) === entry && entry.inFlight === flight) {
        entry.inFlight = undefined
      }
      const entryIsCurrent = entryByCredential.get(credentialFingerprint) === entry
      const fallback = entryIsCurrent ? entry.cached : undefined
      if (
        fallback
        && accessTokenAge(dependencies.now(), fallback.issuedAtEpochMs)
          < fallback.expirationIntervalMs
      ) {
        return fallback.token
      }
      if (entryIsCurrent && !entry.inFlight) {
        entry.cached = undefined
        entryByCredential.delete(credentialFingerprint)
      }
      throw error
    }
  }

  return async (config) => {
    const credentialFingerprint = await dependencies.createFingerprint(config)
    const now = dependencies.now()
    pruneExpiredEntries(now)
    let entry = entryByCredential.get(credentialFingerprint)
    if (!entry) {
      entry = {}
      entryByCredential.set(credentialFingerprint, entry)
    }
    const cached = entry.cached
    if (entry.inFlight) {
      return settleFlight(credentialFingerprint, entry, entry.inFlight)
    }
    if (cached) {
      const age = accessTokenAge(now, cached.issuedAtEpochMs)
      if (age < cached.refreshIntervalMs) {
        return cached.token
      }
    }

    const issuedAtEpochMs = Math.floor(now / 1000) * 1000
    const flight: FcmAccessTokenFlight = {
      promise: Promise.resolve()
        .then(() => dependencies.createAccessToken(config, issuedAtEpochMs))
        .then((result) => {
          const grant = typeof result === "string" ? { token: result } : result
          const { refreshIntervalMs, expirationIntervalMs } = resolveFcmTokenLifetime(grant.ttlMs)
          return {
            issuedAtEpochMs,
            token: grant.token,
            refreshIntervalMs,
            expirationIntervalMs,
          }
        }),
      startedAtEpochMs: now,
    }
    entry.inFlight = flight
    return settleFlight(credentialFingerprint, entry, flight)
  }
}

export const getFcmAccessToken = createFcmAccessTokenProvider()

type FcmErrorDetail = {
  errorCode?: unknown
  fieldViolations?: Array<{
    field?: unknown
  }>
}

type FcmErrorPayload = {
  message?: unknown
  status?: unknown
  details?: FcmErrorDetail[]
}

function isRegistrationTokenField(field: unknown): boolean {
  if (typeof field !== "string") return false
  const normalized = field.trim().toLowerCase()
  return normalized === "message.token" || normalized === "token"
}

function isInvalidRegistrationTokenArgument(error: FcmErrorPayload | undefined): boolean {
  const violations = error?.details?.flatMap((detail) => (
    Array.isArray(detail?.fieldViolations) ? detail.fieldViolations : []
  )) ?? []
  if (violations.length > 0) {
    return violations.some((violation) => isRegistrationTokenField(violation?.field))
  }
  if (typeof error?.message !== "string") return false
  return /\bregistration token\b/i.test(error.message)
    || /\bmessage\.token\b/i.test(error.message)
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
              tag: mobilePushNotificationTag(
                input.payload.route.viewerUserId,
                input.payload.route.targetId,
                input.payload.notificationId,
              ),
              sound: "default",
            },
          },
        },
      }),
    },
  ))
  if (response.ok) return { outcome: "sent" }

  const body = await response.json().catch(() => null) as {
    error?: FcmErrorPayload
  } | null
  const fcmErrorCode = body?.error?.details?.find(
    (detail) => typeof detail?.errorCode === "string",
  )?.errorCode
  const reason = typeof fcmErrorCode === "string"
    ? fcmErrorCode
    : typeof body?.error?.status === "string"
      ? body.error.status
    : "unknown"
  if (response.status === 404 && reason === "UNREGISTERED") {
    return { outcome: "invalid-token" }
  }
  if (response.status === 400 && reason === "INVALID_ARGUMENT") {
    return isInvalidRegistrationTokenArgument(body?.error)
      ? { outcome: "invalid-token" }
      : { outcome: "invalid-payload" }
  }
  throw new PushProviderError("fcm", "provider_send", response.status, reason)
}
