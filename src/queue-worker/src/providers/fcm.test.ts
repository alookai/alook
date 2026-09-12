import { afterEach, describe, expect, it, vi } from "vitest"
import { createFcmAccessToken, sendFcmNotification } from "./fcm"

const payload = {
  notificationId: "4cb8126e-4842-5c26-8d3f-02031c3d014b",
  title: "Alice",
  body: "Hello",
  route: {
    notificationId: "4cb8126e-4842-5c26-8d3f-02031c3d014b",
    messageId: "message-1",
    targetId: "channel-1",
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
  afterEach(() => vi.unstubAllGlobals())

  it("signs a real service-account JWT and uses the default fetch dependency", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ access_token: "access-token" })
    ))
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
    })).rejects.toMatchObject({ provider: "fcm", status: 503, reason: "oauth" })
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
        notification: { title: "Alice", body: "Hello" },
        data: payload.route,
        android: {
          collapse_key: payload.notificationId,
          notification: { tag: payload.notificationId, sound: "default" },
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
    [404, "NOT_FOUND", "UNREGISTERED"],
    [400, "INVALID_ARGUMENT", "INVALID_ARGUMENT"],
  ])("classifies %s/%s as an invalid registration", async (status, outerStatus, errorCode) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({
        error: {
          status: outerStatus,
          details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }],
        },
      }, { status })
    ))
    await expect(sendFcmNotification({
      providerToken: "provider-token",
      accessToken: "access-token",
      payload,
      config: { projectId: "test-project" },
    }, fetchMock as typeof fetch)).resolves.toEqual({ outcome: "invalid-token" })
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
    await expect(result).rejects.toMatchObject({ provider: "fcm", status: 503, reason: "UNAVAILABLE" })
    await expect(result).rejects.not.toThrow(/provider-token|Hello/)
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
      status: 418,
      reason: "unknown",
    })
  })
})
