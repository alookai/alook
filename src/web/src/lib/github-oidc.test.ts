import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearGitHubOidcJwksCache,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_JOB_WORKFLOW_REF,
  GITHUB_OIDC_JWKS_URL,
  GITHUB_OIDC_REF,
  GITHUB_OIDC_REPOSITORY,
  GITHUB_OIDC_REPOSITORY_OWNER,
  verifyGitHubOidcToken,
} from "./github-oidc"

interface TestKeyMaterial {
  kid: string
  privateKey: CryptoKey
  publicJwk: Record<string, unknown>
}

function toBase64Url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

async function generateTestKey(kid: string): Promise<TestKeyMaterial> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      kid,
      use: "sig",
      alg: "RS256",
    },
  }
}

async function signJwt(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const encodedHeader = toBase64Url(JSON.stringify(header))
  const encodedPayload = toBase64Url(JSON.stringify(payload))
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, signingInput),
  )
  return `${encodedHeader}.${encodedPayload}.${toBase64Url(signature)}`
}

const FIXED_NOW_MS = Date.parse("2026-11-28T04:00:00Z")
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000)

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: GITHUB_OIDC_ISSUER,
    aud: GITHUB_OIDC_AUDIENCE,
    repository: GITHUB_OIDC_REPOSITORY,
    repository_owner: GITHUB_OIDC_REPOSITORY_OWNER,
    ref: GITHUB_OIDC_REF,
    event_name: "push",
    job_workflow_ref: GITHUB_OIDC_JOB_WORKFLOW_REF,
    workflow_ref: "alookai/alook/.github/workflows/desktop-release.yml@refs/heads/main",
    iat: FIXED_NOW_SEC - 10,
    nbf: FIXED_NOW_SEC - 10,
    exp: FIXED_NOW_SEC + 300,
    ...overrides,
  }
}

describe("verifyGitHubOidcToken", () => {
  beforeEach(() => {
    clearGitHubOidcJwksCache()
  })

  it.each([
    [
      "desktop-release workflow_call",
      {
        event_name: "push",
        workflow_ref: "alookai/alook/.github/workflows/desktop-release.yml@refs/heads/main",
      },
    ],
    [
      "mobile-release workflow_call",
      {
        event_name: "push",
        workflow_ref: "alookai/alook/.github/workflows/mobile-release.yml@refs/heads/main",
      },
    ],
    [
      "sync-releases workflow_dispatch",
      {
        event_name: "workflow_dispatch",
        workflow_ref: "alookai/alook/.github/workflows/sync-releases.yml@refs/heads/main",
      },
    ],
  ])("verifies a valid RS256 GitHub OIDC JWT for %s", async (_label, claimOverrides) => {
    const key = await generateTestKey("key-1")
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ keys: [key.publicJwk] }), { status: 200 }),
    )
    const token = await signJwt(
      key.privateKey,
      { alg: "RS256", typ: "JWT", kid: key.kid },
      validClaims(claimOverrides),
    )

    const result = await verifyGitHubOidcToken(token, { fetchFn, nowMs: FIXED_NOW_MS })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claims.workflow_ref).toBe(claimOverrides.workflow_ref)
      expect(result.claims.job_workflow_ref).toBe(GITHUB_OIDC_JOB_WORKFLOW_REF)
    }
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0]?.[0]).toBe(GITHUB_OIDC_JWKS_URL)
  })

  it("caches JWKS in-isolate and refetches once on unknown kid rotation", async () => {
    const key1 = await generateTestKey("key-1")
    const key2 = await generateTestKey("key-2")
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [key1.publicJwk] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [key2.publicJwk] }), { status: 200 }))

    const token1 = await signJwt(key1.privateKey, { alg: "RS256", kid: key1.kid }, validClaims())
    const token2 = await signJwt(key2.privateKey, { alg: "RS256", kid: key2.kid }, validClaims())

    expect((await verifyGitHubOidcToken(token1, { fetchFn, nowMs: FIXED_NOW_MS })).ok).toBe(true)
    // Second call with same kid hits cache without refetching JWKS.
    expect((await verifyGitHubOidcToken(token1, { fetchFn, nowMs: FIXED_NOW_MS + 1000 })).ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // New kid triggers a single JWKS refetch and succeeds.
    expect((await verifyGitHubOidcToken(token2, { fetchFn, nowMs: FIXED_NOW_MS + 2000 })).ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("rejects malformed tokens, bad signatures, and wrong keys with 401", async () => {
    const key1 = await generateTestKey("key-1")
    const key2 = await generateTestKey("key-2")
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ keys: [key1.publicJwk] }), { status: 200 }),
    )

    expect(await verifyGitHubOidcToken("not-a-jwt", { fetchFn, nowMs: FIXED_NOW_MS })).toMatchObject({
      ok: false,
      status: 401,
    })

    // Signed with key2 but header claims key1 -> invalid signature.
    const wrongKeyToken = await signJwt(key2.privateKey, { alg: "RS256", kid: key1.kid }, validClaims())
    expect(await verifyGitHubOidcToken(wrongKeyToken, { fetchFn, nowMs: FIXED_NOW_MS })).toMatchObject({
      ok: false,
      status: 401,
    })

    // Tampered payload after signing.
    const validToken = await signJwt(key1.privateKey, { alg: "RS256", kid: key1.kid }, validClaims())
    const [h, , s] = validToken.split(".")
    const tampered = `${h}.${toBase64Url(JSON.stringify(validClaims({ repository: "evil/repo" })))}.${s}`
    expect(await verifyGitHubOidcToken(tampered, { fetchFn, nowMs: FIXED_NOW_MS })).toMatchObject({
      ok: false,
      status: 401,
    })

    // Unsupported alg.
    const hs256 = await signJwt(key1.privateKey, { alg: "HS256", kid: key1.kid }, validClaims())
    expect(await verifyGitHubOidcToken(hs256, { fetchFn, nowMs: FIXED_NOW_MS })).toMatchObject({
      ok: false,
      status: 401,
    })

    // Unknown kid even after refetch.
    const unknownKid = await signJwt(key2.privateKey, { alg: "RS256", kid: "missing-kid" }, validClaims())
    expect(await verifyGitHubOidcToken(unknownKid, { fetchFn, nowMs: FIXED_NOW_MS })).toMatchObject({
      ok: false,
      status: 401,
    })
  })

  it("enforces exp, nbf, and iat with 60s clock skew", async () => {
    const key = await generateTestKey("key-time")
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ keys: [key.publicJwk] }), { status: 200 }),
    )

    // Within 60s skew -> valid
    const slightlyPastExp = await signJwt(
      key.privateKey,
      { alg: "RS256", kid: key.kid },
      validClaims({ exp: FIXED_NOW_SEC - 30 }),
    )
    expect((await verifyGitHubOidcToken(slightlyPastExp, { fetchFn, nowMs: FIXED_NOW_MS })).ok).toBe(true)

    // Beyond 60s skew -> expired (401)
    const expired = await signJwt(
      key.privateKey,
      { alg: "RS256", kid: key.kid },
      validClaims({ exp: FIXED_NOW_SEC - 61 }),
    )
    expect(await verifyGitHubOidcToken(expired, { fetchFn, nowMs: FIXED_NOW_MS })).toMatchObject({
      ok: false,
      status: 401,
    })

    // Future nbf beyond 60s -> 401
    const futureNbf = await signJwt(
      key.privateKey,
      { alg: "RS256", kid: key.kid },
      validClaims({ nbf: FIXED_NOW_SEC + 61 }),
    )
    expect(await verifyGitHubOidcToken(futureNbf, { fetchFn, nowMs: FIXED_NOW_MS })).toMatchObject({
      ok: false,
      status: 401,
    })

    // Future iat beyond 60s -> 401
    const futureIat = await signJwt(
      key.privateKey,
      { alg: "RS256", kid: key.kid },
      validClaims({ iat: FIXED_NOW_SEC + 61 }),
    )
    expect(await verifyGitHubOidcToken(futureIat, { fetchFn, nowMs: FIXED_NOW_MS })).toMatchObject({
      ok: false,
      status: 401,
    })
  })

  it.each([
    ["wrong iss", { iss: "https://evil.example.com" }],
    ["wrong aud", { aud: "https://other.example.com" }],
    ["wrong repository", { repository: "other/alook" }],
    ["wrong repository_owner", { repository_owner: "other" }],
    ["non-main ref", { ref: "refs/heads/feature-branch" }],
    ["pull_request event", { event_name: "pull_request" }],
    ["wrong job_workflow_ref", { job_workflow_ref: "alookai/alook/.github/workflows/ci.yml@refs/heads/main" }],
    ["wrong workflow_ref", { workflow_ref: "alookai/alook/.github/workflows/ci.yml@refs/heads/main" }],
    ["non-main workflow_ref", { workflow_ref: "alookai/alook/.github/workflows/desktop-release.yml@refs/heads/dev" }],
  ])("rejects unauthorized claim (%s) with 403", async (_label, badClaim) => {
    const key = await generateTestKey("key-claims")
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ keys: [key.publicJwk] }), { status: 200 }),
    )
    const token = await signJwt(key.privateKey, { alg: "RS256", kid: key.kid }, validClaims(badClaim))

    expect(await verifyGitHubOidcToken(token, { fetchFn, nowMs: FIXED_NOW_MS })).toMatchObject({
      ok: false,
      status: 403,
    })
  })

  it("returns 503 when GitHub JWKS endpoint cannot be fetched", async () => {
    const key = await generateTestKey("key-down")
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("error", { status: 502 }))
    const token = await signJwt(key.privateKey, { alg: "RS256", kid: key.kid }, validClaims())

    expect(await verifyGitHubOidcToken(token, { fetchFn, nowMs: FIXED_NOW_MS })).toMatchObject({
      ok: false,
      status: 503,
    })
  })
})
