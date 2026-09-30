import {
  ANALYTICS_CONSENT_PROOF_COOKIE,
  ANALYTICS_CONSENT_MAX_AGE_SECONDS,
  ANALYTICS_CONSENT_VERSION,
  type AnalyticsConsentDecision,
} from "@/lib/analytics-consent"

export const GA4_MEASUREMENT_ID = "G-STBCL8F4ZY"
export const GA4_CLIENT_ID_METADATA = "alook_ga_client_id"
export const GA4_SESSION_ID_METADATA = "alook_ga_session_id"
export const GA4_CONSENT_REVISION_METADATA = "alook_ga_consent_revision"
export const GA4_CONSENT_STATUS_METADATA = "alook_ga_consent_status"

const GA4_SESSION_COOKIE = `_ga_${GA4_MEASUREMENT_ID.slice(2).replaceAll("-", "_")}`

const encoder = new TextEncoder()

async function consentSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(new ArrayBuffer(binary.length))
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

export async function createAnalyticsConsentProof(
  decision: AnalyticsConsentDecision,
  secret: string,
  issuedAtMs = Date.now(),
): Promise<string> {
  const issuedAtSeconds = Math.floor(issuedAtMs / 1000)
  const payload = `${ANALYTICS_CONSENT_VERSION}.${decision}.${issuedAtSeconds}`
  const signature = await crypto.subtle.sign(
    "HMAC",
    await consentSigningKey(secret),
    encoder.encode(payload),
  )
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`
}

export async function verifyAnalyticsConsentProof(
  proof: string | null | undefined,
  secret: string,
  nowMs = Date.now(),
): Promise<{ decision: AnalyticsConsentDecision; sourceVersion: number } | null> {
  const parts = proof?.split(".") ?? []
  if (parts.length !== 4) return null
  const [version, decision, issuedAtRaw, signatureRaw] = parts
  if (version !== ANALYTICS_CONSENT_VERSION) return null
  if (decision !== "granted" && decision !== "denied") return null
  if (!/^\d+$/u.test(issuedAtRaw)) return null
  const issuedAtSeconds = Number(issuedAtRaw)
  const nowSeconds = Math.floor(nowMs / 1000)
  if (!Number.isSafeInteger(issuedAtSeconds)) return null
  if (issuedAtSeconds > nowSeconds + 300) return null
  if (nowSeconds - issuedAtSeconds > ANALYTICS_CONSENT_MAX_AGE_SECONDS) return null
  const signature = fromBase64Url(signatureRaw)
  if (!signature) return null
  const payload = `${version}.${decision}.${issuedAtRaw}`
  const valid = await crypto.subtle.verify(
    "HMAC",
    await consentSigningKey(secret),
    signature,
    encoder.encode(payload),
  )
  return valid ? { decision, sourceVersion: issuedAtSeconds } : null
}

function cookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

export function parseGaClientId(value: string | null | undefined): string | null {
  const parts = value?.split(".") ?? []
  if (parts.length < 4 || !/^GA\d+$/u.test(parts[0]!)) return null
  const clientId = parts.slice(-2).join(".")
  return /^\d{1,20}\.\d{1,20}$/u.test(clientId) ? clientId : null
}

export function parseGaSessionId(value: string | null | undefined): string | null {
  if (!value) return null
  const gs2 = /^GS2\.\d+\.s(\d{1,20})(?:\$|$)/u.exec(value)?.[1]
  if (gs2 && Number.isSafeInteger(Number(gs2)) && Number(gs2) > 0) return gs2
  const gs1 = /^GS1\.\d+\.(\d{1,20})(?:\.|$)/u.exec(value)?.[1]
  return gs1 && Number.isSafeInteger(Number(gs1)) && Number(gs1) > 0 ? gs1 : null
}

export async function readCheckoutAnalyticsConsent(cookieHeader: string, secret: string) {
  const proof = await verifyAnalyticsConsentProof(
    cookieValue(cookieHeader, ANALYTICS_CONSENT_PROOF_COOKIE),
    secret,
  )
  if (proof?.decision !== "granted") {
    return {
      decision: proof?.decision ?? null,
      sourceVersion: proof?.sourceVersion ?? null,
      identity: null,
    }
  }
  const clientId = parseGaClientId(cookieValue(cookieHeader, "_ga"))
  const sessionId = parseGaSessionId(cookieValue(cookieHeader, GA4_SESSION_COOKIE))
  if (!clientId || !sessionId) return { ...proof, identity: null }
  return {
    ...proof,
    identity: {
      clientId,
      sessionId,
    },
  }
}
