import type { PushNotificationPayload } from "../notification-payload"
import { PushProviderError, type PushProviderResult } from "./apns"

export interface FcmConfig {
  projectId: string
  clientEmail: string
  privateKey: string
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
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(config.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64Url(signature)}`
}

type FcmTokenDependencies = {
  fetch: typeof fetch
  createAssertion: typeof createFcmServiceAccountAssertion
}

export async function createFcmAccessToken(
  config: FcmConfig,
  dependencies: FcmTokenDependencies = {
    fetch,
    createAssertion: createFcmServiceAccountAssertion,
  },
): Promise<string> {
  const assertion = await dependencies.createAssertion(config)
  const response = await dependencies.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })
  const body = await response.json().catch(() => null) as { access_token?: unknown } | null
  if (!response.ok || typeof body?.access_token !== "string" || !body.access_token) {
    throw new PushProviderError("fcm", response.status, "oauth")
  }
  return body.access_token
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
  const response = await fetchImpl(
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
            collapse_key: input.payload.notificationId,
            notification: {
              tag: input.payload.notificationId,
              sound: "default",
            },
          },
        },
      }),
    },
  )
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
  throw new PushProviderError("fcm", response.status, reason)
}
