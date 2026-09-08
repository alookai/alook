import { decodeJwt, decodeProtectedHeader, exportJWK, importJWK, importPKCS8, jwtVerify } from "jose"
import { describe, expect, it, vi } from "vitest"
import {
  APPLE_CLIENT_SECRET_TTL_SECONDS,
  APPLE_ISSUER,
  AppleAuthConfigurationError,
  generateAppleClientSecret,
  mapAppleProfileToUser,
  resolveAppleAuthConfig,
} from "./apple-auth"

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgiyvo0X+VQ0yIrOaN
nlrnUclopnvuuMfoc8HHly3505OhRANCAAQWUcdZ8uTSAsFuwtNy4KtsKqgeqYxg
l6kwL5D4N3pEGYGIDjV69Sw0zAt43480WqJv7HCL0mQnyqFmSrxj8jMa
-----END PRIVATE KEY-----`

const completeEnv = {
  APPLE_CLIENT_ID: "ai.alook.web",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_KEY_ID: "KEY1234567",
  APPLE_PRIVATE_KEY: TEST_PRIVATE_KEY,
}

const partialEnvs = Array.from({ length: 14 }, (_, index) => {
  const mask = index + 1
  return {
    mask,
    env: Object.fromEntries(
      Object.entries(completeEnv).filter((_, keyIndex) => mask & (1 << keyIndex)),
    ),
  }
})

describe("Apple auth configuration", () => {
  it("disables Apple only when all four values are absent", () => {
    expect(resolveAppleAuthConfig({})).toEqual({ enabled: false })
    expect(resolveAppleAuthConfig({
      APPLE_CLIENT_ID: "   ",
      APPLE_TEAM_ID: "",
      APPLE_KEY_ID: undefined,
      APPLE_PRIVATE_KEY: "\n",
    })).toEqual({ enabled: false })
  })

  it.each(partialEnvs)("fails closed for partial configuration mask $mask", ({ env }) => {
    let error: unknown
    try {
      resolveAppleAuthConfig(env)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AppleAuthConfigurationError)
    expect(String(error)).not.toContain(TEST_PRIVATE_KEY)
    expect(String(error)).not.toContain(completeEnv.APPLE_KEY_ID)
  })

  it("returns trimmed complete configuration", () => {
    expect(resolveAppleAuthConfig({
      ...completeEnv,
      APPLE_CLIENT_ID: ` ${completeEnv.APPLE_CLIENT_ID} `,
    })).toEqual({
      enabled: true,
      config: expect.objectContaining({ clientId: completeEnv.APPLE_CLIENT_ID }),
    })
  })
})

describe("Apple client secret", () => {
  it("signs the exact Apple JWT contract with a fixed ES256 key", async () => {
    const state = resolveAppleAuthConfig(completeEnv)
    if (!state.enabled) throw new Error("test configuration unexpectedly disabled")
    const now = 1_800_000_000
    const token = await generateAppleClientSecret(state.config, now)
    const privateKey = await importPKCS8(TEST_PRIVATE_KEY, "ES256", { extractable: true })
    const jwk = await exportJWK(privateKey)
    delete jwk.d
    const publicKey = await importJWK(jwk, "ES256")
    const verified = await jwtVerify(token, publicKey, {
      issuer: completeEnv.APPLE_TEAM_ID,
      subject: completeEnv.APPLE_CLIENT_ID,
      audience: APPLE_ISSUER,
      currentDate: new Date(now * 1000),
    })

    expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: completeEnv.APPLE_KEY_ID })
    expect(decodeJwt(token)).toMatchObject({
      iss: completeEnv.APPLE_TEAM_ID,
      sub: completeEnv.APPLE_CLIENT_ID,
      aud: APPLE_ISSUER,
      iat: now,
      exp: now + APPLE_CLIENT_SECRET_TTL_SECONDS,
    })
    expect(verified.payload.exp! - verified.payload.iat!).toBe(APPLE_CLIENT_SECRET_TTL_SECONDS)
    expect(token).not.toContain(TEST_PRIVATE_KEY)
  })

  it("uses the current time when no signing clock is supplied", async () => {
    const state = resolveAppleAuthConfig(completeEnv)
    if (!state.enabled) throw new Error("test configuration unexpectedly disabled")
    const before = Math.floor(Date.now() / 1000)
    const token = await generateAppleClientSecret(state.config)
    const after = Math.floor(Date.now() / 1000)
    const payload = decodeJwt(token)

    expect(payload.iat).toBeGreaterThanOrEqual(before)
    expect(payload.iat).toBeLessThanOrEqual(after)
    expect(payload.exp! - payload.iat!).toBe(APPLE_CLIENT_SECRET_TTL_SECONDS)
  })
})

describe("Apple profile mapping", () => {
  it("rejects an empty subject before identity or email handling", async () => {
    const lookup = vi.fn()
    await expect(mapAppleProfileToUser({
      sub: "   ",
      email: "person@example.com",
      email_verified: true,
    }, lookup)).resolves.toEqual({ email: undefined })
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([
    ["person@example.com", true],
    ["private-token@privaterelay.appleid.com", "true"],
  ])("uses a first-authorized verified email without an identity lookup: %s", async (email, verified) => {
    const lookup = vi.fn()
    await expect(mapAppleProfileToUser({
      sub: "stable-sub",
      email,
      email_verified: verified,
    }, lookup)).resolves.toEqual({ email, emailVerified: true })
    expect(lookup).not.toHaveBeenCalled()
  })

  it("rejects an empty stable subject before identity lookup", async () => {
    const lookup = vi.fn()
    await expect(mapAppleProfileToUser({
      sub: "   ",
      email: "person@example.com",
      email_verified: true,
    }, lookup)).resolves.toEqual({ email: undefined })
    expect(lookup).not.toHaveBeenCalled()
  })

  it("rehydrates a returning Apple identity from its stored verified user", async () => {
    const lookup = vi.fn().mockResolvedValue({
      email: "person@example.com",
      emailVerified: true,
      name: "Existing Person",
    })
    await expect(mapAppleProfileToUser({ sub: "stable-sub" }, lookup)).resolves.toEqual({
      email: "person@example.com",
      emailVerified: true,
      name: "Existing Person",
    })
    expect(lookup).toHaveBeenCalledWith("stable-sub")
  })

  it.each([
    { sub: "new-sub" },
    { sub: "new-sub", email: "unverified@example.com", email_verified: false },
  ])("returns no placeholder for a never-seen identity: %o", async (profile) => {
    const result = await mapAppleProfileToUser(
      profile,
      vi.fn().mockResolvedValue(null),
    )
    expect(result).toEqual({ email: undefined })
    expect(JSON.stringify(result)).not.toContain("placeholder")
    expect(JSON.stringify(result)).not.toContain("new-sub")
  })

  it("does not rehydrate an existing user whose local email is unverified", async () => {
    await expect(mapAppleProfileToUser(
      { sub: "stable-sub" },
      vi.fn().mockResolvedValue({
        email: "person@example.com",
        emailVerified: false,
        name: "Person",
      }),
    )).resolves.toEqual({ email: undefined })
  })
})
