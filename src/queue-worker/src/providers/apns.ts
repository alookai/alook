import type { PushNotificationPayload } from "../notification-payload"

interface ApnsConfig {
  teamId: string
  keyId: string
  privateKey: string
  topic: string
}

type ApnsTokenConfig = Pick<ApnsConfig, "teamId" | "keyId" | "privateKey">

const APNS_PROVIDER_TOKEN_REFRESH_INTERVAL_MS = 50 * 60 * 1000
const APNS_PROVIDER_TOKEN_EXPIRATION_INTERVAL_MS = 60 * 60 * 1000

export interface ApnsSendInput {
  providerToken: string
  providerEnvironment: "sandbox" | "production"
  payload: PushNotificationPayload
  config: ApnsConfig
}

export type PushProviderResult = { outcome: "sent" | "invalid-token" }

export class PushProviderError extends Error {
  constructor(
    readonly provider: "apns" | "fcm",
    readonly status: number,
    readonly reason: string,
  ) {
    super(`${provider} request failed (${status}:${reason})`)
    this.name = "PushProviderError"
  }
}

function base64Url(value: string | ArrayBuffer | Uint8Array): string {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array ? value : new Uint8Array(value)
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

async function createApnsProviderToken(
  config: ApnsTokenConfig,
  now: number,
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: config.keyId }))
  const claims = base64Url(JSON.stringify({
    iss: config.teamId,
    iat: Math.floor(now / 1000),
  }))
  const signingInput = `${header}.${claims}`
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(config.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64Url(signature)}`
}

async function createCredentialFingerprint(config: ApnsTokenConfig): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify([
    config.teamId,
    config.keyId,
    base64Url(pemToBytes(config.privateKey)),
  ]))
  return base64Url(await crypto.subtle.digest("SHA-256", encoded))
}

type ApnsProviderTokenDependencies = {
  createProviderToken: typeof createApnsProviderToken
  createFingerprint: typeof createCredentialFingerprint
  now: () => number
}

type CachedApnsProviderToken = {
  issuedAtEpochMs: number
  token: string
}

type ApnsProviderTokenFlight = {
  promise: Promise<CachedApnsProviderToken>
  startedAtEpochMs: number
}

type ApnsProviderTokenEntry = {
  cached?: CachedApnsProviderToken
  inFlight?: ApnsProviderTokenFlight
}

function providerTokenAge(now: number, issuedAtEpochMs: number): number {
  return Math.max(0, now - issuedAtEpochMs)
}

/**
 * Keep one entry per signing authority in the isolate. Valid or in-flight
 * entries are never evicted: APNs rejects tokens updated too frequently and
 * tokens older than one hour, so capacity pressure cannot override identity
 * or time ownership. Refreshing at 50 minutes leaves margin before expiry.
 */
export function createApnsProviderTokenProvider(
  overrides: Partial<ApnsProviderTokenDependencies> = {},
): (config: ApnsTokenConfig) => Promise<string> {
  const dependencies: ApnsProviderTokenDependencies = {
    createProviderToken: createApnsProviderToken,
    createFingerprint: createCredentialFingerprint,
    now: Date.now,
    ...overrides,
  }
  const entryByCredential = new Map<string, ApnsProviderTokenEntry>()

  function pruneExpiredEntries(now: number): void {
    for (const [credentialFingerprint, entry] of entryByCredential) {
      if (entry.inFlight) continue
      if (
        !entry.cached
        || providerTokenAge(now, entry.cached.issuedAtEpochMs)
          >= APNS_PROVIDER_TOKEN_EXPIRATION_INTERVAL_MS
      ) {
        entryByCredential.delete(credentialFingerprint)
      }
    }
  }

  async function settleFlight(
    credentialFingerprint: string,
    entry: ApnsProviderTokenEntry,
    flight: ApnsProviderTokenFlight,
  ): Promise<string> {
    try {
      const signed = await flight.promise
      if (entryByCredential.get(credentialFingerprint) === entry && entry.inFlight === flight) {
        entry.cached = signed
        entry.inFlight = undefined
      }
      return signed.token
    } catch (error) {
      if (entryByCredential.get(credentialFingerprint) === entry && entry.inFlight === flight) {
        entry.inFlight = undefined
      }
      const entryIsCurrent = entryByCredential.get(credentialFingerprint) === entry
      const fallback = entryIsCurrent ? entry.cached : undefined
      if (
        fallback
        && providerTokenAge(dependencies.now(), fallback.issuedAtEpochMs)
          < APNS_PROVIDER_TOKEN_EXPIRATION_INTERVAL_MS
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
      const age = providerTokenAge(now, cached.issuedAtEpochMs)
      if (age < APNS_PROVIDER_TOKEN_REFRESH_INTERVAL_MS) {
        return cached.token
      }
    }

    const issuedAtEpochMs = Math.floor(now / 1000) * 1000
    const flight: ApnsProviderTokenFlight = {
      promise: Promise.resolve()
        .then(() => dependencies.createProviderToken(config, issuedAtEpochMs))
        .then((token) => ({ issuedAtEpochMs, token })),
      startedAtEpochMs: now,
    }
    entry.inFlight = flight
    return settleFlight(credentialFingerprint, entry, flight)
  }
}

const getApnsProviderToken = createApnsProviderTokenProvider()

type ApnsDependencies = {
  fetch: typeof fetch
  getProviderToken: typeof getApnsProviderToken
}

const defaultDependencies: ApnsDependencies = {
  fetch,
  getProviderToken: getApnsProviderToken,
}

export async function sendApnsNotification(
  input: ApnsSendInput,
  dependencies: ApnsDependencies = defaultDependencies,
): Promise<PushProviderResult> {
  const authorization = await dependencies.getProviderToken(input.config)
  const host = input.providerEnvironment === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com"
  const response = await dependencies.fetch(
    `${host}/3/device/${encodeURIComponent(input.providerToken)}`,
    {
      method: "POST",
      headers: {
        authorization: `bearer ${authorization}`,
        "content-type": "application/json",
        "apns-topic": input.config.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-id": input.payload.notificationId,
        "apns-collapse-id": input.payload.notificationId,
      },
      body: JSON.stringify({
        aps: {
          alert: {
            title: input.payload.title,
            body: input.payload.body,
          },
          sound: "default",
          "thread-id": input.payload.route.targetId,
        },
        ...input.payload.route,
      }),
    },
  )
  if (response.ok) return { outcome: "sent" }

  const body = await response.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof body?.reason === "string" ? body.reason : "unknown"
  if (["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(reason)) {
    return { outcome: "invalid-token" }
  }
  throw new PushProviderError("apns", response.status, reason)
}
