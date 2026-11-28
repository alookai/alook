export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com"
export const GITHUB_OIDC_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks"
export const GITHUB_OIDC_AUDIENCE = "https://alook.ai"
export const GITHUB_OIDC_REPOSITORY = "alookai/alook"
export const GITHUB_OIDC_REPOSITORY_OWNER = "alookai"
export const GITHUB_OIDC_REF = "refs/heads/main"
export const GITHUB_OIDC_JOB_WORKFLOW_REF = "alookai/alook/.github/workflows/sync-releases.yml@refs/heads/main"

const ALLOWED_EVENT_NAMES = new Set(["push", "workflow_dispatch"])
const ALLOWED_WORKFLOW_REFS = new Set([
  "alookai/alook/.github/workflows/desktop-release.yml@refs/heads/main",
  "alookai/alook/.github/workflows/mobile-release.yml@refs/heads/main",
  "alookai/alook/.github/workflows/sync-releases.yml@refs/heads/main",
])

const CLOCK_SKEW_SECONDS = 60
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000
const JWKS_FETCH_TIMEOUT_MS = 10_000
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

interface JwksCacheEntry {
  keysByKid: Map<string, CryptoKey>
  expiresAt: number
}

interface RawJwk {
  kty?: unknown
  kid?: unknown
  use?: unknown
  alg?: unknown
  n?: unknown
  e?: unknown
}

interface VerifiedGitHubOidcClaims {
  iss: string
  aud: string
  repository: string
  repository_owner: string
  ref: string
  event_name: string
  job_workflow_ref: string
  workflow_ref: string
  exp: number
  nbf?: number
  iat?: number
}

export type GitHubOidcVerificationResult =
  | { ok: true; claims: VerifiedGitHubOidcClaims }
  | { ok: false; status: 401 | 403 | 503; error: string }

export interface VerifyGitHubOidcOptions {
  fetchFn?: typeof fetch
  nowMs?: number
}

let jwksCache: JwksCacheEntry | null = null

export function clearGitHubOidcJwksCache(): void {
  jwksCache = null
}

function decodeBase64Url(input: string): Uint8Array | null {
  if (!input || !BASE64URL_RE.test(input)) return null
  const paddedLength = input.length + ((4 - (input.length % 4)) % 4)
  if (paddedLength - input.length === 3) return null
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(paddedLength, "=")
  let binary: string
  try {
    binary = atob(base64)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function decodeJwtJsonPart(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(segment)
  if (!bytes) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

async function fetchJwksKeys(fetchFn: typeof fetch, nowMs: number): Promise<Map<string, CryptoKey> | null> {
  let response: Response
  try {
    response = await fetchFn(GITHUB_OIDC_JWKS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    })
  } catch {
    return null
  }
  if (!response.ok) return null

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null
  }

  if (!body || typeof body !== "object" || !Array.isArray((body as { keys?: unknown }).keys)) {
    return null
  }

  const keysByKid = new Map<string, CryptoKey>()
  for (const raw of (body as { keys: RawJwk[] }).keys) {
    if (!raw || typeof raw !== "object") continue
    if (raw.kty !== "RSA") continue
    if (typeof raw.kid !== "string" || !raw.kid) continue
    if (raw.use !== undefined && raw.use !== "sig") continue
    if (raw.alg !== undefined && raw.alg !== "RS256") continue
    if (typeof raw.n !== "string" || typeof raw.e !== "string") continue
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: raw.n, e: raw.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      )
      keysByKid.set(raw.kid, cryptoKey)
    } catch {
      continue
    }
  }

  if (keysByKid.size === 0) return null

  jwksCache = {
    keysByKid,
    expiresAt: nowMs + JWKS_CACHE_TTL_MS,
  }
  return keysByKid
}

async function resolveSigningKey(
  kid: string,
  fetchFn: typeof fetch,
  nowMs: number,
): Promise<{ status: "found"; key: CryptoKey } | { status: "missing" } | { status: "fetch_failed" }> {
  if (jwksCache && nowMs < jwksCache.expiresAt) {
    const cached = jwksCache.keysByKid.get(kid)
    if (cached) return { status: "found", key: cached }
  }

  const refreshed = await fetchJwksKeys(fetchFn, nowMs)
  if (!refreshed) return { status: "fetch_failed" }
  const key = refreshed.get(kid)
  return key ? { status: "found", key } : { status: "missing" }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export async function verifyGitHubOidcToken(
  token: string,
  options: VerifyGitHubOidcOptions = {},
): Promise<GitHubOidcVerificationResult> {
  const fetchFn = options.fetchFn ?? fetch
  const nowMs = options.nowMs ?? Date.now()
  const nowSec = Math.floor(nowMs / 1000)

  const parts = token.split(".")
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, status: 401, error: "Malformed JWT" }
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts
  const header = decodeJwtJsonPart(headerSegment)
  const payload = decodeJwtJsonPart(payloadSegment)
  const signatureBytes = decodeBase64Url(signatureSegment)
  if (!header || !payload || !signatureBytes || signatureBytes.byteLength === 0) {
    return { ok: false, status: 401, error: "Malformed JWT" }
  }

  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 256) {
    return { ok: false, status: 401, error: "Unsupported JWT header" }
  }

  const keyResolution = await resolveSigningKey(header.kid, fetchFn, nowMs)
  if (keyResolution.status === "fetch_failed") {
    return { ok: false, status: 503, error: "Unable to fetch OIDC signing keys" }
  }
  if (keyResolution.status === "missing") {
    return { ok: false, status: 401, error: "Unknown JWT signing key" }
  }

  const signingInput = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
  let verified = false
  try {
    verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      keyResolution.key,
      signatureBytes as BufferSource,
      signingInput as BufferSource,
    )
  } catch {
    verified = false
  }
  if (!verified) {
    return { ok: false, status: 401, error: "Invalid JWT signature" }
  }

  if (!isFiniteNumber(payload.exp) || payload.exp <= nowSec - CLOCK_SKEW_SECONDS) {
    return { ok: false, status: 401, error: "JWT has expired" }
  }
  if (payload.nbf !== undefined && (!isFiniteNumber(payload.nbf) || payload.nbf > nowSec + CLOCK_SKEW_SECONDS)) {
    return { ok: false, status: 401, error: "JWT is not yet valid" }
  }
  if (payload.iat !== undefined && (!isFiniteNumber(payload.iat) || payload.iat > nowSec + CLOCK_SKEW_SECONDS)) {
    return { ok: false, status: 401, error: "JWT issued-at time is invalid" }
  }

  if (
    payload.iss !== GITHUB_OIDC_ISSUER ||
    payload.aud !== GITHUB_OIDC_AUDIENCE ||
    payload.repository !== GITHUB_OIDC_REPOSITORY ||
    payload.repository_owner !== GITHUB_OIDC_REPOSITORY_OWNER ||
    payload.ref !== GITHUB_OIDC_REF ||
    typeof payload.event_name !== "string" ||
    !ALLOWED_EVENT_NAMES.has(payload.event_name) ||
    payload.job_workflow_ref !== GITHUB_OIDC_JOB_WORKFLOW_REF ||
    typeof payload.workflow_ref !== "string" ||
    !ALLOWED_WORKFLOW_REFS.has(payload.workflow_ref)
  ) {
    return { ok: false, status: 403, error: "Unauthorized OIDC token claims" }
  }

  return {
    ok: true,
    claims: {
      iss: payload.iss,
      aud: payload.aud,
      repository: payload.repository,
      repository_owner: payload.repository_owner,
      ref: payload.ref,
      event_name: payload.event_name,
      job_workflow_ref: payload.job_workflow_ref,
      workflow_ref: payload.workflow_ref,
      exp: payload.exp,
      ...(payload.nbf !== undefined ? { nbf: payload.nbf } : {}),
      ...(payload.iat !== undefined ? { iat: payload.iat } : {}),
    },
  }
}
