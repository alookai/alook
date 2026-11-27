import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createFcmAccessToken,
  createFcmAccessTokenProvider,
  sendFcmNotification,
} from "./fcm"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const payload = {
  notificationId: "4cb8126e-4842-5c26-8d3f-02031c3d014b",
  title: "Studio · #announcements · Release notes",
  body: "Alice: Hello",
  route: {
    notificationId: "4cb8126e-4842-5c26-8d3f-02031c3d014b",
    messageId: "message-1",
    targetId: "channel-1",
    viewerUserId: "user-1",
  },
}

async function createRsaPrivateKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]) as CryptoKeyPair
  const privateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)
  const encoded = Buffer.from(privateKey).toString("base64")
  const lines = encoded.match(/.{1,64}/gu) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`
}

describe("FCM HTTP v1 adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("signs a real service-account JWT and uses the default fetch dependency", async () => {
    const fetchMock = vi.fn(function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
      return Promise.resolve(Response.json({ access_token: "access-token" }))
    })
    vi.stubGlobal("fetch", fetchMock)
    const before = Math.floor(Date.now() / 1000)

    await expect(createFcmAccessToken({
      projectId: "test-project",
      clientEmail: "test@example.test",
      privateKey: await createRsaPrivateKeyPem(),
    })).resolves.toBe("access-token")

    const [, init] = fetchMock.mock.calls[0]!
    const assertion = new URLSearchParams(String(init?.body)).get("assertion")!
    const [headerPart, claimsPart, signaturePart] = assertion.split(".")
    expect(JSON.parse(Buffer.from(headerPart!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    })
    expect(JSON.parse(Buffer.from(claimsPart!, "base64url").toString())).toMatchObject({
      iss: "test@example.test",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: expect.any(Number),
      exp: expect.any(Number),
    })
    const claims = JSON.parse(Buffer.from(claimsPart!, "base64url").toString()) as {
      exp: number
      iat: number
    }
    expect(claims.iat).toBeGreaterThanOrEqual(before)
    expect(claims.exp).toBe(claims.iat + 3600)
    expect(signaturePart).not.toBe("")
    expect(fetchMock.mock.contexts[0]).toBeUndefined()
  })

  it("exchanges a service-account assertion for a short-lived access token", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ access_token: "access-token" })
    ))
    const token = await createFcmAccessToken({
      projectId: "test-project",
      clientEmail: "test@example.test",
      privateKey: "test-private-key",
    }, {
      fetch: fetchMock as typeof fetch,
      createAssertion: vi.fn(async () => "signed-assertion"),
    })

    expect(token).toBe("access-token")
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://oauth2.googleapis.com/token")
    expect(String(init?.body)).toContain("assertion=signed-assertion")
    expect(String(init?.body)).toContain("grant_type=")
  })

  it("rejects a failed OAuth exchange without an access token", async () => {
    await expect(createFcmAccessToken({
      projectId: "test-project",
      clientEmail: "test@example.test",
      privateKey: "unused",
    }, {
      fetch: vi.fn(async () => new Response("not json", { status: 503 })) as typeof fetch,
      createAssertion: vi.fn(async () => "signed-assertion"),
    })).rejects.toMatchObject({
      provider: "fcm",
      stage: "oauth_fetch",
      status: 503,
      reason: "oauth",
    })
  })

  it("classifies service-account key import failures", async () => {
    const result = createFcmAccessToken({
      projectId: "test-project",
      clientEmail: "test@example.test",
      privateKey: "sensitive-invalid-key",
    })

    await expect(result).rejects.toMatchObject({
      provider: "fcm",
      stage: "key_import",
    })
    await expect(result).rejects.not.toThrow(/sensitive-invalid-key/)
  })

  it("classifies service-account signing failures", async () => {
    const privateKey = await createRsaPrivateKeyPem()
    vi.spyOn(crypto.subtle, "sign").mockRejectedValueOnce(new TypeError("sensitive-sign"))
    const result = createFcmAccessToken({
      projectId: "test-project",
      clientEmail: "test@example.test",
      privateKey,
    })

    await expect(result).rejects.toMatchObject({
      provider: "fcm",
      stage: "sign",
      errorName: "TypeError",
    })
    await expect(result).rejects.not.toThrow(/sensitive-sign/)
  })

  it("classifies OAuth transport failures", async () => {
    const result = createFcmAccessToken({
      projectId: "test-project",
      clientEmail: "test@example.test",
      privateKey: "unused",
    }, {
      fetch: vi.fn(async () => { throw new TypeError("sensitive-oauth") }) as typeof fetch,
      createAssertion: vi.fn(async () => "signed-assertion"),
    })

    await expect(result).rejects.toMatchObject({
      provider: "fcm",
      stage: "oauth_fetch",
      errorName: "TypeError",
    })
    await expect(result).rejects.not.toThrow(/sensitive-oauth/)
  })

  it("sends notification/data payloads with deterministic collapse semantics", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ name: "accepted" })
    ))

    await expect(sendFcmNotification({
      providerToken: "provider-token",
      accessToken: "access-token",
      payload,
      config: { projectId: "test-project" },
    }, fetchMock as typeof fetch)).resolves.toEqual({ outcome: "sent" })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send")
    expect(init?.headers).toMatchObject({ authorization: "Bearer access-token" })
    expect(JSON.parse(init?.body as string)).toEqual({
      message: {
        token: "provider-token",
        notification: {
          title: "Studio · #announcements · Release notes",
          body: "Alice: Hello",
        },
        data: payload.route,
        android: {
          priority: "high",
          collapse_key: payload.notificationId,
          notification: {
            tag: `alook:v2:${payload.route.viewerUserId}:${payload.route.targetId}:${payload.notificationId}`,
            sound: "default",
          },
        },
      },
    })
  })

  it("uses the default fetch dependency for notification sends", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ name: "accepted" })
    ))
    vi.stubGlobal("fetch", fetchMock)

    await expect(sendFcmNotification({
      providerToken: "provider-token",
      accessToken: "access-token",
      payload,
      config: { projectId: "test-project" },
    })).resolves.toEqual({ outcome: "sent" })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      "404 UNREGISTERED",
      404,
      {
        error: {
          status: "NOT_FOUND",
          details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }],
        },
      },
    ],
    [
      "400 INVALID_ARGUMENT registration token message",
      400,
      {
        error: {
          status: "INVALID_ARGUMENT",
          message: "The registration token is not a valid FCM registration token",
          details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" }],
        },
      },
    ],
    [
      "400 INVALID_ARGUMENT message.token violation",
      400,
      {
        error: {
          status: "INVALID_ARGUMENT",
          message: "Invalid value at 'message.token'",
          details: [
            { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" },
            {
              "@type": "type.googleapis.com/google.rpc.BadRequest",
              fieldViolations: [{ field: "message.token", description: "Invalid registration token" }],
            },
          ],
        },
      },
    ],
  ])("classifies %s as an invalid registration", async (_name, status, errorBody) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json(errorBody, { status })
    ))
    await expect(sendFcmNotification({
      providerToken: "provider-token",
      accessToken: "access-token",
      payload,
      config: { projectId: "test-project" },
    }, fetchMock as typeof fetch)).resolves.toEqual({ outcome: "invalid-token" })
  })

  it.each([
    [
      "oversized payload message",
      {
        error: {
          status: "INVALID_ARGUMENT",
          message: "Message too big",
          details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" }],
        },
      },
    ],
    [
      "non-token field violation",
      {
        error: {
          status: "INVALID_ARGUMENT",
          message: "Invalid value at 'message.data'",
          details: [
            { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" },
            {
              "@type": "type.googleapis.com/google.rpc.BadRequest",
              fieldViolations: [{ field: "message.data", description: "Data payload exceeds limit" }],
            },
          ],
        },
      },
    ],
    [
      "bare INVALID_ARGUMENT without token detail",
      {
        error: {
          status: "INVALID_ARGUMENT",
          details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" }],
        },
      },
    ],
  ])("classifies 400 INVALID_ARGUMENT %s as invalid-payload without disabling the device", async (_name, errorBody) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json(errorBody, { status: 400 })
    ))
    await expect(sendFcmNotification({
      providerToken: "provider-token",
      accessToken: "access-token",
      payload,
      config: { projectId: "test-project" },
    }, fetchMock as typeof fetch)).resolves.toEqual({ outcome: "invalid-payload" })
  })

  it("throws a token-free provider error for non-registration failures", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 })
    ))
    const result = sendFcmNotification({
      providerToken: "provider-token",
      accessToken: "access-token",
      payload,
      config: { projectId: "test-project" },
    }, fetchMock as typeof fetch)
    await expect(result).rejects.toMatchObject({
      provider: "fcm",
      stage: "provider_send",
      status: 503,
      reason: "UNAVAILABLE",
    })
    await expect(result).rejects.not.toThrow(/provider-token|Hello/)
  })

  it("classifies provider transport failures", async () => {
    const result = sendFcmNotification({
      providerToken: "provider-token",
      accessToken: "access-token",
      payload,
      config: { projectId: "test-project" },
    }, vi.fn(async () => { throw new TypeError("sensitive-send") }) as typeof fetch)

    await expect(result).rejects.toMatchObject({
      provider: "fcm",
      stage: "provider_send",
      errorName: "TypeError",
    })
    await expect(result).rejects.not.toThrow(/sensitive-send/)
  })

  it("uses an unknown reason for a malformed provider error", async () => {
    const fetchMock = vi.fn(async () => new Response("not json", { status: 418 }))

    await expect(sendFcmNotification({
      providerToken: "provider-token",
      accessToken: "access-token",
      payload,
      config: { projectId: "test-project" },
    }, fetchMock as typeof fetch)).rejects.toMatchObject({
      provider: "fcm",
      stage: "provider_send",
      status: 418,
      reason: "unknown",
    })
  })

  it("reuses a cached OAuth access token across sends until the 50-minute refresh window", async () => {
    let now = 1_700_000_000_000
    const createAccessToken = vi.fn(async (_config, issuedAt: number) => ({
      token: `token-${issuedAt}`,
      ttlMs: 60 * 60 * 1000,
    }))
    const getAccessToken = createFcmAccessTokenProvider({
      createAccessToken,
      now: () => now,
    })
    const config = {
      clientEmail: "test@example.test",
      privateKey: "-----BEGIN PRIVATE KEY-----\ndGVzdC1wcml2YXRlLWtleQ==\n-----END PRIVATE KEY-----",
    }

    await expect(getAccessToken(config)).resolves.toBe("token-1700000000000")
    now += 49 * 60 * 1000
    await expect(getAccessToken(config)).resolves.toBe("token-1700000000000")
    expect(createAccessToken).toHaveBeenCalledTimes(1)

    now += 60 * 1000
    await expect(getAccessToken(config)).resolves.toBe("token-1700003000000")
    expect(createAccessToken).toHaveBeenCalledTimes(2)
  })

  it("honors a shorter expires_in from the OAuth token response", async () => {
    const privateKey = await createRsaPrivateKeyPem()
    let now = 1_700_000_000_000
    let count = 0
    const fetchMock = vi.fn(async () => {
      count += 1
      return Response.json({ access_token: `short-${count}`, expires_in: 300 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const getAccessToken = createFcmAccessTokenProvider({ now: () => now })
    const config = { clientEmail: "test@example.test", privateKey }

    await expect(getAccessToken(config)).resolves.toBe("short-1")
    now += 249 * 1000
    await expect(getAccessToken(config)).resolves.toBe("short-1")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 1000
    await expect(getAccessToken(config)).resolves.toBe("short-2")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("single-flights concurrent OAuth exchanges for the same credential and isolates distinct ones", async () => {
    const flights = new Map<string, ReturnType<typeof deferred<string>>>()
    const createAccessToken = vi.fn((config) => {
      const flight = deferred<string>()
      flights.set(config.clientEmail, flight)
      return flight.promise
    })
    const getAccessToken = createFcmAccessTokenProvider({ createAccessToken })
    const keyPem = "-----BEGIN PRIVATE KEY-----\ndGVzdC1wcml2YXRlLWtleQ==\n-----END PRIVATE KEY-----"
    const configA = { clientEmail: "a@example.test", privateKey: keyPem }
    const configAEscaped = { clientEmail: "a@example.test", privateKey: keyPem.replace(/\n/gu, "\\n") }
    const configB = { clientEmail: "b@example.test", privateKey: keyPem }

    const pending = Promise.all([
      getAccessToken(configA),
      getAccessToken(configB),
      getAccessToken(configAEscaped),
    ])
    await vi.waitFor(() => expect(createAccessToken).toHaveBeenCalledTimes(2))
    flights.get("a@example.test")!.resolve("token-a")
    flights.get("b@example.test")!.resolve("token-b")

    await expect(pending).resolves.toEqual(["token-a", "token-b", "token-a"])
    expect(createAccessToken).toHaveBeenCalledTimes(2)
  })

  it("classifies malformed PEM fingerprints and recovers after an initial exchange failure", async () => {
    const getAccessTokenWithDefaultFingerprint = createFcmAccessTokenProvider()
    const invalidPem = getAccessTokenWithDefaultFingerprint({
      clientEmail: "test@example.test",
      privateKey: "sensitive-invalid-***",
    })
    await expect(invalidPem).rejects.toMatchObject({
      provider: "fcm",
      stage: "credential_fingerprint",
    })
    await expect(invalidPem).rejects.not.toThrow(/sensitive-invalid/)

    const createAccessToken = vi.fn()
      .mockRejectedValueOnce(new Error("oauth failed"))
      .mockResolvedValueOnce("recovered-token")
    const getAccessToken = createFcmAccessTokenProvider({
      createFingerprint: async (config) => config.clientEmail,
      createAccessToken,
    })
    const config = { clientEmail: "test@example.test", privateKey: "unused" }

    await expect(getAccessToken(config)).rejects.toThrow("oauth failed")
    await expect(getAccessToken(config)).resolves.toBe("recovered-token")
    expect(createAccessToken).toHaveBeenCalledTimes(2)
  })

  it("falls back to an unexpired cached token on refresh failure and handles clock rollback", async () => {
    const issuedAt = 1_700_000_000_000
    let now = issuedAt
    const createAccessToken = vi.fn()
      .mockResolvedValueOnce("initial-token")
      .mockRejectedValueOnce(new Error("temporary oauth outage"))
      .mockRejectedValueOnce(new Error("outage after expiry"))
    const getAccessToken = createFcmAccessTokenProvider({
      createFingerprint: async (config) => config.clientEmail,
      createAccessToken,
      now: () => now,
    })
    const config = { clientEmail: "test@example.test", privateKey: "unused" }

    await expect(getAccessToken(config)).resolves.toBe("initial-token")
    now = issuedAt - 5 * 60 * 1000
    await expect(getAccessToken(config)).resolves.toBe("initial-token")
    expect(createAccessToken).toHaveBeenCalledTimes(1)

    now = issuedAt + (60 * 60 * 1000) - 1
    await expect(getAccessToken(config)).resolves.toBe("initial-token")
    expect(createAccessToken).toHaveBeenCalledTimes(2)

    now += 1
    await expect(getAccessToken(config)).rejects.toThrow("outage after expiry")
    expect(createAccessToken).toHaveBeenCalledTimes(3)
  })
})
