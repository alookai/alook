import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createFcmAccessToken,
  createFcmDataAccessToken,
  FCM_ANDROID_ANALYTICS_LABEL,
  listFcmAndroidDeliveryData,
  sendFcmNotification,
} from "./fcm"

const payload = {
  notificationId: "4cb8126e-4842-5c26-8d3f-02031c3d014b",
  title: "Studio · #announcements · Release notes",
  body: "Alice: Hello",
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
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("signs a real service-account JWT and uses the default fetch dependency", async () => {
    let fetchReceiver: unknown = Symbol("unset")
    const fetchMock = vi.fn(function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
      fetchReceiver = this
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
    expect(fetchReceiver).toBeUndefined()
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

  it("uses the cloud-platform scope only for delivery-data access", async () => {
    const createAssertion = vi.fn(async () => "signed-assertion")
    await expect(createFcmDataAccessToken({
      projectId: "test-project",
      clientEmail: "test@example.test",
      privateKey: "test-private-key",
    }, {
      fetch: vi.fn(async () => Response.json({ access_token: "data-access-token" })) as typeof fetch,
      createAssertion,
    })).resolves.toBe("data-access-token")

    expect(createAssertion).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "test-project" }),
      "https://www.googleapis.com/auth/cloud-platform",
    )
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
          notification: { tag: payload.notificationId, sound: "default" },
          fcm_options: { analytics_label: FCM_ANDROID_ANALYTICS_LABEL },
        },
      },
    })
  })

  it("reads bounded paginated delivery aggregates and projects only safe owned-label fields", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        androidDeliveryData: [
          {
            appId: "app/id",
            date: { year: 2026, month: 9, day: 20 },
            analyticsLabel: FCM_ANDROID_ANALYTICS_LABEL,
            data: {
              countMessagesAccepted: "123",
              countNotificationsAccepted: "120",
              messageOutcomePercents: {
                delivered: 90,
                pending: 1,
                collapsed: 2,
                droppedTooManyPendingMessages: 3,
                droppedAppForceStopped: 1,
                droppedDeviceInactive: 2,
                droppedTtlExpired: 1,
                secretUnexpectedField: "must-not-escape",
              },
              deliveryPerformancePercents: {
                deliveredNoDelay: 75,
                delayedDeviceOffline: 5,
                delayedDeviceDoze: 4,
                delayedMessageThrottled: 3,
                delayedUserStopped: 3,
              },
              messageInsightPercents: { priorityLowered: 6 },
              proxyNotificationInsightPercents: {
                proxied: 25,
                failed: 1,
                skippedUnsupported: 20,
                skippedNotThrottled: 40,
                skippedUnconfigured: 10,
                skippedOptedOut: 4,
              },
              rawIdentifier: "must-not-escape",
            },
          },
          {
            appId: "app/id",
            date: { year: 2026, month: 9, day: 20 },
            analyticsLabel: "some_other_sender",
            data: { countMessagesAccepted: "999" },
          },
        ],
        nextPageToken: "page two/plus+",
      }))
      .mockResolvedValueOnce(Response.json({
        androidDeliveryData: [{
          appId: "app/id",
          date: { year: 2026, month: 9, day: 21 },
          analyticsLabel: FCM_ANDROID_ANALYTICS_LABEL,
          data: { countMessagesAccepted: "5" },
        }],
      }))

    await expect(listFcmAndroidDeliveryData({
      projectId: "project/id",
      appId: "app/id",
      accessToken: "access-token",
    }, fetchMock as typeof fetch)).resolves.toEqual({
      rows: [
        {
          date: "2026-09-20",
          countMessagesAccepted: "123",
          countNotificationsAccepted: "120",
          messageOutcomePercents: {
            delivered: 90,
            pending: 1,
            collapsed: 2,
            droppedTooManyPendingMessages: 3,
            droppedAppForceStopped: 1,
            droppedDeviceInactive: 2,
            droppedTtlExpired: 1,
          },
          deliveryPerformancePercents: {
            deliveredNoDelay: 75,
            delayedDeviceOffline: 5,
            delayedDeviceDoze: 4,
            delayedMessageThrottled: 3,
            delayedUserStopped: 3,
          },
          messageInsightPercents: { priorityLowered: 6 },
          proxyNotificationInsightPercents: {
            proxied: 25,
            failed: 1,
            skippedUnsupported: 20,
            skippedNotThrottled: 40,
            skippedUnconfigured: 10,
            skippedOptedOut: 4,
          },
        },
        { date: "2026-09-21", countMessagesAccepted: "5" },
      ],
      pageCount: 2,
      discardedRowCount: 0,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://fcmdata.googleapis.com/v1beta1/projects/project%2Fid/androidApps/app%2Fid/deliveryData?pageSize=1000",
    )
    expect(String(fetchMock.mock.calls[1]![0])).toContain("pageToken=page+two%2Fplus%2B")
    expect(fetchMock.mock.calls[0]![1]?.headers).toEqual({ authorization: "Bearer access-token" })
  })

  it("discards malformed owned-label rows without copying their content", async () => {
    const result = await listFcmAndroidDeliveryData({
      projectId: "test-project",
      appId: "test-app",
      accessToken: "access-token",
    }, vi.fn(async () => Response.json({
      androidDeliveryData: [
        {
          appId: "test-app",
          date: { year: 2026, month: 2, day: 31 },
          analyticsLabel: FCM_ANDROID_ANALYTICS_LABEL,
          data: { countMessagesAccepted: "credential-like-value" },
        },
        "raw-sensitive-value",
      ],
    })) as typeof fetch)

    expect(result).toEqual({ rows: [], pageCount: 1, discardedRowCount: 2 })
    expect(JSON.stringify(result)).not.toContain("credential-like-value")
    expect(JSON.stringify(result)).not.toContain("raw-sensitive-value")
  })

  it("rejects delivery-data HTTP and malformed response failures without response content", async () => {
    const httpResult = listFcmAndroidDeliveryData({
      projectId: "test-project",
      appId: "test-app",
      accessToken: "access-token",
    }, vi.fn(async () => new Response("secret-upstream-body", { status: 503 })) as typeof fetch)
    await expect(httpResult).rejects.toMatchObject({
      provider: "fcm",
      stage: "delivery_data_fetch",
      status: 503,
    })
    await expect(httpResult).rejects.not.toThrow(/secret-upstream-body|access-token/)

    const shapeResult = listFcmAndroidDeliveryData({
      projectId: "test-project",
      appId: "test-app",
      accessToken: "access-token",
    }, vi.fn(async () => Response.json({ androidDeliveryData: "secret-shape" })) as typeof fetch)
    await expect(shapeResult).rejects.toMatchObject({
      provider: "fcm",
      stage: "delivery_data_parse",
    })
    await expect(shapeResult).rejects.not.toThrow(/secret-shape|access-token/)
  })

  it("rejects repeated delivery-data page tokens", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      androidDeliveryData: [],
      nextPageToken: "repeat",
    }))

    await expect(listFcmAndroidDeliveryData({
      projectId: "test-project",
      appId: "test-app",
      accessToken: "access-token",
    }, fetchMock as typeof fetch)).rejects.toMatchObject({
      provider: "fcm",
      stage: "delivery_data_parse",
      reason: "invalid_page_token",
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
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
})
