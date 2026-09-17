import {
  ANALYTICS_CONSENT_MAX_AGE_SECONDS,
  ANALYTICS_CONSENT_VERSION,
  type AnalyticsConsentDecision,
} from "@/lib/analytics-consent"

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
): Promise<AnalyticsConsentDecision | null> {
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
  return valid ? decision : null
}
