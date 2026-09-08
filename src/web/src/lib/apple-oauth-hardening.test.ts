import {
  SignJWT,
  createRemoteJWKSet,
  customFetch,
  exportJWK,
  generateKeyPair,
} from "jose"
import { getTestInstance } from "better-auth/test"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { APPLE_ISSUER, mapAppleProfileToUser } from "./apple-auth"
import {
  APPLE_JWKS_URL,
  appleOauthHardeningPlugin,
  verifyAppleIdToken,
} from "./apple-oauth-hardening"

const CLIENT_ID = "ai.alook.web"
const EXPECTED_NONCE = "request-bound-nonce"
const NOW_SECONDS = 1_800_000_000
const NOW = new Date(NOW_SECONDS * 1000)

let rsaPrivateKey: CryptoKey
let rsaPublicKey: CryptoKey
let otherRsaPrivateKey: CryptoKey
let ecPrivateKey: CryptoKey

beforeAll(async () => {
  const rsa = await generateKeyPair("RS256")
  rsaPrivateKey = rsa.privateKey
  rsaPublicKey = rsa.publicKey
  otherRsaPrivateKey = (await generateKeyPair("RS256")).privateKey
  ecPrivateKey = (await generateKeyPair("ES256")).privateKey
})

type Claims = {
  iss?: string
  aud?: string
  sub?: string
  nonce?: string
  iat?: number
  exp?: number
  email?: string
  email_verified?: boolean
}

async function signToken(
  claims: Claims = {},
  options: { alg?: "RS256" | "ES256"; key?: CryptoKey } = {},
): Promise<string> {
  const alg = options.alg ?? "RS256"
  const key = options.key ?? rsaPrivateKey
  return new SignJWT({
    iss: APPLE_ISSUER,
    aud: CLIENT_ID,
    sub: "apple-stable-subject",
    nonce: EXPECTED_NONCE,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 300,
    ...claims,
  })
    .setProtectedHeader({ alg, kid: "apple-test-key" })
    .sign(key)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

describe("Apple ID-token verification", () => {
  it.each([
    ["the exact nonce", async () => EXPECTED_NONCE],
    ["Apple's SHA-256 nonce form", async () => sha256Hex(EXPECTED_NONCE)],
  ])("accepts a valid RS256 Apple token with %s", async (_, nonce) => {
    const token = await signToken({ nonce: await nonce() })
    await expect(verifyAppleIdToken(token, EXPECTED_NONCE, CLIENT_ID, {
      key: rsaPublicKey,
      currentDate: NOW,
    })).resolves.toBe(true)
  })

  it("loads verification keys only from Apple's fixed JWKS URL", async () => {
    const jwk = await exportJWK(rsaPublicKey)
    Object.assign(jwk, { kid: "apple-test-key", alg: "RS256", use: "sig" })
    const fetchJwks = vi.fn(async (url: string) => {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
    const jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL), {
      [customFetch]: fetchJwks,
    })

    await expect(verifyAppleIdToken(
      await signToken(),
      EXPECTED_NONCE,
      CLIENT_ID,
      { key: jwks, currentDate: NOW },
    )).resolves.toBe(true)
    expect(fetchJwks).toHaveBeenCalledOnce()
    expect(fetchJwks.mock.calls[0]?.[0]).toBe(APPLE_JWKS_URL)
  })

  it.each([
    ["wrong issuer", { iss: "https://attacker.example" }],
    ["wrong audience", { aud: "another.service" }],
    ["wrong nonce", { nonce: "another-request" }],
    ["expired token", { exp: NOW_SECONDS - 1 }],
    ["token older than one hour", { iat: NOW_SECONDS - 3601 }],
    ["empty subject", { sub: "" }],
    ["empty nonce", { nonce: "" }],
  ])("rejects a %s", async (_, claims) => {
    await expect(verifyAppleIdToken(
      await signToken(claims),
      EXPECTED_NONCE,
      CLIENT_ID,
      { key: rsaPublicKey, currentDate: NOW },
    )).resolves.toBe(false)
  })

  it.each(["iss", "aud", "sub", "nonce", "iat", "exp"] as const)(
    "rejects a token missing the %s claim",
    async (claim) => {
      const claims: Claims = {
        iss: APPLE_ISSUER,
        aud: CLIENT_ID,
        sub: "apple-stable-subject",
        nonce: EXPECTED_NONCE,
        iat: NOW_SECONDS,
        exp: NOW_SECONDS + 300,
      }
      delete claims[claim]
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "apple-test-key" })
        .sign(rsaPrivateKey)

      await expect(verifyAppleIdToken(token, EXPECTED_NONCE, CLIENT_ID, {
        key: rsaPublicKey,
        currentDate: NOW,
      })).resolves.toBe(false)
    },
  )

  it("rejects an invalid signature", async () => {
    await expect(verifyAppleIdToken(
      await signToken({}, { key: otherRsaPrivateKey }),
      EXPECTED_NONCE,
      CLIENT_ID,
      { key: rsaPublicKey, currentDate: NOW },
    )).resolves.toBe(false)
  })

  it("rejects a tampered signature", async () => {
    const [header, payload, signature] = (await signToken()).split(".")
    const tamperedSignature = `${signature?.startsWith("a") ? "b" : "a"}${signature?.slice(1)}`
    await expect(verifyAppleIdToken(
      `${header}.${payload}.${tamperedSignature}`,
      EXPECTED_NONCE,
      CLIENT_ID,
      { key: rsaPublicKey, currentDate: NOW },
    )).resolves.toBe(false)
  })

  it("rejects every algorithm except RS256", async () => {
    await expect(verifyAppleIdToken(
      await signToken({}, { alg: "ES256", key: ecPrivateKey }),
      EXPECTED_NONCE,
      CLIENT_ID,
      { key: rsaPublicKey, currentDate: NOW },
    )).resolves.toBe(false)
  })

  it.each([
    ["malformed", "not-a-jwt"],
    ["missing token", ""],
  ])("fails closed for a %s without leaking parser errors", async (_, token) => {
    await expect(verifyAppleIdToken(
      token,
      EXPECTED_NONCE,
      CLIENT_ID,
      { key: rsaPublicKey, currentDate: NOW },
    )).resolves.toBe(false)
  })

  it("requires both the expected nonce and client ID before parsing", async () => {
    const token = await signToken()
    await expect(verifyAppleIdToken(token, "", CLIENT_ID, {
      key: rsaPublicKey,
      currentDate: NOW,
    })).resolves.toBe(false)
    await expect(verifyAppleIdToken(token, EXPECTED_NONCE, "", {
      key: rsaPublicKey,
      currentDate: NOW,
    })).resolves.toBe(false)
  })
})

describe("Better Auth Apple callback integration", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("binds authorization, token exchange, JWKS verification, persistence, and single-use state", async () => {
    const publicJwk = await exportJWK(rsaPublicKey)
    Object.assign(publicJwk, { kid: "apple-test-key", alg: "RS256", use: "sig" })
    let nextIdToken = ""
    let rejectCode = false
    const externalFetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === APPLE_JWKS_URL) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url === `${APPLE_ISSUER}/auth/token`) {
        if (rejectCode) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response(JSON.stringify({
          access_token: "apple-access-token",
          refresh_token: "apple-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: nextIdToken,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`Unexpected external request: ${url}`)
    })
    vi.stubGlobal("fetch", externalFetch)

    let findExistingAppleUser = async (_sub: string) => null as {
      email: string
      emailVerified: boolean | null
      name: string
    } | null
    const { auth, db } = await getTestInstance({
      socialProviders: {
        apple: {
          clientId: CLIENT_ID,
          clientSecret: "test-client-secret",
          mapProfileToUser: (profile) => mapAppleProfileToUser(
            profile,
            findExistingAppleUser,
          ),
        },
      },
      plugins: [appleOauthHardeningPlugin(CLIENT_ID)],
    }, { disableTestUser: true })
    findExistingAppleUser = async (sub) => {
      const linked = await db.findOne<{ userId: string }>({
        model: "account",
        where: [
          { field: "providerId", value: "apple" },
          { field: "accountId", value: sub },
        ],
      })
      if (!linked) return null
      return db.findOne<{
        email: string
        emailVerified: boolean | null
        name: string
      }>({
        model: "user",
        where: [{ field: "id", value: linked.userId }],
      })
    }

    const directIdToken = await auth.handler(new Request(
      "http://localhost:3000/api/auth/sign-in/social",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          provider: "apple",
          callbackURL: "/signed-in",
          idToken: { token: "client-submitted-id-token" },
        }),
      },
    ))
    expect(directIdToken.status).toBe(404)
    await expect(directIdToken.json()).resolves.toMatchObject({
      code: "ID_TOKEN_NOT_SUPPORTED",
    })
    expect(await db.count({ model: "user" })).toBe(0)
    expect(await db.count({ model: "account" })).toBe(0)
    expect(externalFetch).not.toHaveBeenCalled()

    async function begin() {
      const response = await auth.handler(new Request(
        "http://localhost:3000/api/auth/sign-in/social",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:3000",
          },
          body: JSON.stringify({
            provider: "apple",
            callbackURL: "/signed-in",
            disableRedirect: true,
          }),
        },
      ))
      expect(response.status).toBe(200)
      const result = await response.json() as { url: string }
      const url = new URL(result.url!)
      expect(url.origin).toBe(APPLE_ISSUER)
      expect(url.searchParams.get("state")).toBeTruthy()
      expect(url.searchParams.get("code_challenge")).toBeTruthy()
      expect(url.searchParams.get("nonce")).toBeTruthy()
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]
      expect(cookie).toBeTruthy()
      return { url, cookie: cookie! }
    }

    async function callback(params: Record<string, string>, cookie: string) {
      const post = await auth.handler(new Request(
        "http://localhost:3000/api/auth/callback/apple",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(params),
          redirect: "manual",
        },
      ))
      expect(post.status).toBe(302)
      const normalizedCallback = post.headers.get("location")
      expect(normalizedCallback).toBeTruthy()
      return auth.handler(new Request(normalizedCallback!, {
        headers: { Cookie: cookie },
        redirect: "manual",
      }))
    }

    async function liveToken(
      nonce: string,
      claims: Claims = {},
      key = rsaPrivateKey,
    ) {
      const now = Math.floor(Date.now() / 1000)
      return new SignJWT({
        iss: APPLE_ISSUER,
        aud: CLIENT_ID,
        sub: "apple-integration-subject",
        email: "person@example.com",
        email_verified: true,
        nonce,
        iat: now,
        exp: now + 300,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "apple-test-key" })
        .sign(key)
    }

    for (const invalid of [
      async (nonce: string) => liveToken(nonce, { iss: "https://attacker.example" }),
      async (nonce: string) => liveToken(nonce, { aud: "another.service" }),
      async (nonce: string) => liveToken("wrong-nonce"),
      async (nonce: string) => liveToken(nonce, { exp: Math.floor(Date.now() / 1000) - 1 }),
      async (nonce: string) => liveToken(nonce, {}, otherRsaPrivateKey),
    ]) {
      const authorization = await begin()
      const state = authorization.url.searchParams.get("state")!
      const nonce = authorization.url.searchParams.get("nonce")!
      nextIdToken = await invalid(nonce)
      const response = await callback({
        code: "invalid-token-code",
        state,
        iss: APPLE_ISSUER,
      }, authorization.cookie)
      expect(response.status).toBe(302)
      expect(new URL(response.headers.get("location")!).searchParams.get("error"))
        .toBe("unable_to_get_user_info")
      expect(await db.count({ model: "user" })).toBe(0)
      expect(await db.count({ model: "account" })).toBe(0)
    }

    const rejectedAuthorization = await begin()
    rejectCode = true
    const rejectedCode = await callback({
      code: "rejected-code",
      state: rejectedAuthorization.url.searchParams.get("state")!,
      iss: APPLE_ISSUER,
    }, rejectedAuthorization.cookie)
    expect(new URL(rejectedCode.headers.get("location")!).searchParams.get("error"))
      .toBe("invalid_code")
    expect(await db.count({ model: "user" })).toBe(0)
    rejectCode = false

    const cancelledAuthorization = await begin()
    const cancelled = await callback({
      error: "access_denied",
      state: cancelledAuthorization.url.searchParams.get("state")!,
    }, cancelledAuthorization.cookie)
    expect(new URL(cancelled.headers.get("location")!).searchParams.get("error"))
      .toBe("access_denied")
    expect(await db.count({ model: "user" })).toBe(0)

    const unverifiedEmailAuthorization = await begin()
    nextIdToken = await liveToken(
      unverifiedEmailAuthorization.url.searchParams.get("nonce")!,
      {
        sub: "never-seen-unverified-email-subject",
        email: "unverified@example.com",
        email_verified: false,
      },
    )
    const unverifiedEmail = await callback({
      code: "unverified-email-code",
      state: unverifiedEmailAuthorization.url.searchParams.get("state")!,
      iss: APPLE_ISSUER,
    }, unverifiedEmailAuthorization.cookie)
    expect(new URL(unverifiedEmail.headers.get("location")!).searchParams.get("error"))
      .toBe("email_not_found")
    expect(await db.count({ model: "user" })).toBe(0)
    expect(await db.count({ model: "account" })).toBe(0)

    const authorization = await begin()
    const state = authorization.url.searchParams.get("state")!
    const nonce = authorization.url.searchParams.get("nonce")!
    nextIdToken = await liveToken(nonce)
    const success = await callback(
      {
        code: "valid-code",
        state,
        iss: APPLE_ISSUER,
        user: JSON.stringify({
          name: { firstName: "Apple", lastName: "Person" },
          email: "person@example.com",
        }),
      },
      authorization.cookie,
    )

    expect(success.status).toBe(302)
    expect(success.headers.get("location")).toBe("/signed-in")
    expect(await db.count({ model: "user" })).toBe(1)
    expect(await db.count({ model: "account" })).toBe(1)
    await expect(db.findOne<{ name: string }>({
      model: "user",
      where: [{ field: "email", value: "person@example.com" }],
    })).resolves.toMatchObject({ name: "Apple Person" })
    await expect(db.findOne<{ providerId: string; accountId: string }>({
      model: "account",
      where: [{ field: "providerId", value: "apple" }],
    })).resolves.toMatchObject({
      providerId: "apple",
      accountId: "apple-integration-subject",
    })

    const tokenRequestsBeforeReplay = externalFetch.mock.calls.filter(([input]) => {
      const url = input instanceof Request ? input.url : String(input)
      return url === `${APPLE_ISSUER}/auth/token`
    }).length
    const replay = await callback(
      { code: "valid-code", state, iss: APPLE_ISSUER },
      authorization.cookie,
    )
    expect(replay.status).toBe(302)
    expect(new URL(replay.headers.get("location")!).searchParams.get("error"))
      .toBe("state_mismatch")
    const tokenRequestsAfterReplay = externalFetch.mock.calls.filter(([input]) => {
      const url = input instanceof Request ? input.url : String(input)
      return url === `${APPLE_ISSUER}/auth/token`
    }).length
    expect(tokenRequestsAfterReplay).toBe(tokenRequestsBeforeReplay)
    expect(await db.count({ model: "user" })).toBe(1)
    expect(await db.count({ model: "account" })).toBe(1)

    const sameEmailAuthorization = await begin()
    nextIdToken = await liveToken(
      sameEmailAuthorization.url.searchParams.get("nonce")!,
      { sub: "apple-same-email-subject" },
    )
    const sameEmail = await callback({
      code: "same-email-code",
      state: sameEmailAuthorization.url.searchParams.get("state")!,
      iss: APPLE_ISSUER,
    }, sameEmailAuthorization.cookie)
    expect(sameEmail.headers.get("location")).toBe("/signed-in")
    expect(await db.count({ model: "user" })).toBe(1)
    expect(await db.count({ model: "account" })).toBe(2)

    const relayAuthorization = await begin()
    nextIdToken = await liveToken(
      relayAuthorization.url.searchParams.get("nonce")!,
      {
        sub: "apple-relay-subject",
        email: "relay-token@privaterelay.appleid.com",
      },
    )
    const relay = await callback({
      code: "relay-code",
      state: relayAuthorization.url.searchParams.get("state")!,
      iss: APPLE_ISSUER,
    }, relayAuthorization.cookie)
    expect(relay.headers.get("location")).toBe("/signed-in")
    expect(await db.count({ model: "user" })).toBe(2)
    expect(await db.count({ model: "account" })).toBe(3)

    const returningAuthorization = await begin()
    nextIdToken = await liveToken(
      returningAuthorization.url.searchParams.get("nonce")!,
      {
        email: undefined,
        email_verified: undefined,
      },
    )
    const returning = await callback({
      code: "returning-code",
      state: returningAuthorization.url.searchParams.get("state")!,
      iss: APPLE_ISSUER,
    }, returningAuthorization.cookie)
    expect(returning.headers.get("location")).toBe("/signed-in")
    expect(await db.count({ model: "user" })).toBe(2)
    expect(await db.count({ model: "account" })).toBe(3)

    const missingEmailAuthorization = await begin()
    nextIdToken = await liveToken(
      missingEmailAuthorization.url.searchParams.get("nonce")!,
      {
        sub: "never-seen-apple-subject",
        email: undefined,
        email_verified: undefined,
      },
    )
    const missingEmail = await callback({
      code: "missing-email-code",
      state: missingEmailAuthorization.url.searchParams.get("state")!,
      iss: APPLE_ISSUER,
    }, missingEmailAuthorization.cookie)
    expect(new URL(missingEmail.headers.get("location")!).searchParams.get("error"))
      .toBe("email_not_found")
    expect(await db.count({ model: "user" })).toBe(2)
    expect(await db.count({ model: "account" })).toBe(3)
  })
})

type AuthorizationData = {
  state: string
  codeVerifier: string
  redirectURI: string
  idTokenNonce?: string
}

type TokenData = {
  accessToken?: string
  idToken?: string
  expectedIdTokenNonce?: string
}

function makeProvider() {
  const accountSubject = vi.fn(({ profile }: { profile: { sub: string } }) => profile.sub)
  const createAuthorizationURL = vi.fn(async (data: AuthorizationData) => {
    const url = new URL("https://appleid.apple.com/auth/authorize")
    url.searchParams.set("state", data.state)
    url.searchParams.set("code_challenge", data.codeVerifier)
    return url
  })
  const getUserInfo = vi.fn(async (_tokens: TokenData) => ({
    user: { email: "person@example.com", emailVerified: true, name: "Person" },
    data: { sub: "apple-stable-subject" },
  }))
  const provider = {
    id: "apple",
    name: "Apple",
    options: {} as { disableIdTokenSignIn?: boolean },
    requiresIdTokenNonce: false,
    issuer: undefined as string | undefined,
    accountSubject,
    createAuthorizationURL,
    validateAuthorizationCode: vi.fn(),
    getUserInfo,
  }
  return { provider, accountSubject, createAuthorizationURL, getUserInfo }
}

function initializeProvider(
  verifyIdToken = vi.fn(async () => true),
  providers = [makeProvider().provider],
) {
  const plugin = appleOauthHardeningPlugin(CLIENT_ID, verifyIdToken)
  plugin.init?.({ socialProviders: providers } as never)
  return { plugin, provider: providers[0], verifyIdToken }
}

describe("Apple OAuth hardening plugin", () => {
  it("requires state-bound nonces and disables the client-submitted ID-token flow", () => {
    const { provider } = initializeProvider()

    expect(provider.requiresIdTokenNonce).toBe(true)
    expect(provider.issuer).toBe(APPLE_ISSUER)
    expect(provider.options.disableIdTokenSignIn).toBe(true)
  })

  it("forwards the identical state nonce to Apple without changing state or PKCE", async () => {
    const fixture = makeProvider()
    const originalAccountSubject = fixture.provider.accountSubject
    const { provider } = initializeProvider(vi.fn(async () => true), [fixture.provider])
    const data = {
      state: "signed-state",
      codeVerifier: "pkce-verifier",
      redirectURI: "https://alook.ai/api/auth/callback/apple",
      idTokenNonce: EXPECTED_NONCE,
    }

    const url = await provider.createAuthorizationURL(data)

    expect(fixture.createAuthorizationURL).toHaveBeenCalledWith(data)
    expect(url.searchParams.get("state")).toBe(data.state)
    expect(url.searchParams.get("code_challenge")).toBe(data.codeVerifier)
    expect(url.searchParams.get("nonce")).toBe(EXPECTED_NONCE)
    expect(provider.accountSubject).toBe(originalAccountSubject)
    expect(provider.accountSubject({ profile: { sub: "stable-sub" } })).toBe("stable-sub")
  })

  it("fails closed before redirect when no nonce is available", async () => {
    const fixture = makeProvider()
    const { provider } = initializeProvider(vi.fn(async () => true), [fixture.provider])

    await expect(provider.createAuthorizationURL({
      state: "signed-state",
      codeVerifier: "pkce-verifier",
      redirectURI: "https://alook.ai/api/auth/callback/apple",
    })).rejects.toThrow("Apple OAuth authorization could not be initialized")
    expect(fixture.createAuthorizationURL).not.toHaveBeenCalled()
  })

  it("delegates profile mapping only after the callback ID token verifies", async () => {
    const fixture = makeProvider()
    const verify = vi.fn(async () => true)
    const { provider } = initializeProvider(verify, [fixture.provider])
    const tokens = {
      accessToken: "access-token",
      idToken: "signed-id-token",
      expectedIdTokenNonce: EXPECTED_NONCE,
    }

    await expect(provider.getUserInfo(tokens)).resolves.toEqual({
      user: { email: "person@example.com", emailVerified: true, name: "Person" },
      data: { sub: "apple-stable-subject" },
    })
    expect(verify).toHaveBeenCalledWith("signed-id-token", EXPECTED_NONCE, CLIENT_ID)
    expect(fixture.getUserInfo).toHaveBeenCalledWith(tokens)
  })

  it.each([
    ["invalid token", { idToken: "invalid", expectedIdTokenNonce: EXPECTED_NONCE }],
    ["missing token", { expectedIdTokenNonce: EXPECTED_NONCE }],
    ["missing expected nonce", { idToken: "signed-id-token" }],
  ])("returns no user and performs no mapping for a callback with %s", async (_, tokens) => {
    const fixture = makeProvider()
    const verify = vi.fn(async () => false)
    const { provider } = initializeProvider(verify, [fixture.provider])

    await expect(provider.getUserInfo(tokens)).resolves.toBeNull()
    expect(fixture.getUserInfo).not.toHaveBeenCalled()
  })

  it.each([
    ["no Apple provider", []],
    ["duplicate Apple providers", [makeProvider().provider, makeProvider().provider]],
  ])("fails initialization for %s", (_, providers) => {
    const plugin = appleOauthHardeningPlugin(CLIENT_ID)
    expect(() => plugin.init?.({ socialProviders: providers } as never))
      .toThrow("Apple OAuth hardening could not be initialized")
  })

  it("fails initialization if the Apple provider options contract drifts", () => {
    const provider = { ...makeProvider().provider, options: undefined }
    const plugin = appleOauthHardeningPlugin(CLIENT_ID)
    expect(() => plugin.init?.({ socialProviders: [provider] } as never))
      .toThrow("Apple OAuth hardening could not be initialized")
  })
})
