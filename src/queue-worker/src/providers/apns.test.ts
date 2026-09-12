import { describe, expect, it, vi } from "vitest"
import {
  createApnsProviderTokenProvider,
  PushProviderError,
  sendApnsNotification,
} from "./apns"

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

function input(environment: "sandbox" | "production" = "production") {
  return {
    providerToken: "provider-token",
    providerEnvironment: environment,
    payload,
    config: {
      teamId: "test-team",
      keyId: "test-key",
      privateKey: "-----BEGIN PRIVATE KEY-----\ndGVzdC1wcml2YXRlLWtleQ==\n-----END PRIVATE KEY-----",
      topic: "app.test",
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function createEcPrivateKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey({
    name: "ECDSA",
    namedCurve: "P-256",
  }, true, ["sign", "verify"]) as CryptoKeyPair
  const privateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)
  const encoded = Buffer.from(privateKey).toString("base64")
  const lines = encoded.match(/.{1,64}/gu) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`
}

describe("APNs adapter", () => {
  it("signs a real provider JWT and uses the default send dependencies", async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 200 })
    ))
    globalThis.fetch = fetchMock as typeof fetch
    vi.resetModules()

    try {
      const { sendApnsNotification: sendWithFreshDefaults } = await import("./apns")
      await expect(sendWithFreshDefaults({
        ...input(),
        config: { ...input().config, privateKey: await createEcPrivateKeyPem() },
      })).resolves.toEqual({ outcome: "sent" })

      const [, init] = fetchMock.mock.calls[0]!
      const authorization = (init?.headers as Record<string, string>).authorization
      const [headerPart, claimsPart, signaturePart] = authorization.slice("bearer ".length).split(".")
      expect(JSON.parse(Buffer.from(headerPart!, "base64url").toString())).toEqual({
        alg: "ES256",
        kid: "test-key",
      })
      expect(JSON.parse(Buffer.from(claimsPart!, "base64url").toString())).toMatchObject({
        iss: "test-team",
        iat: expect.any(Number),
      })
      expect(signaturePart).not.toBe("")
    } finally {
      globalThis.fetch = originalFetch
      vi.resetModules()
    }
  })

  it("sends the minimal alert with deterministic replace/group identifiers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 200 })
    ))

    await expect(sendApnsNotification(input("sandbox"), {
      fetch: fetchMock as typeof fetch,
      getProviderToken: vi.fn(async () => "signed-token"),
    })).resolves.toEqual({ outcome: "sent" })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.sandbox.push.apple.com/3/device/provider-token")
    expect(init?.headers).toMatchObject({
      authorization: "bearer signed-token",
      "apns-topic": "app.test",
      "apns-push-type": "alert",
      "apns-id": payload.notificationId,
      "apns-collapse-id": payload.notificationId,
    })
    expect(JSON.parse(init?.body as string)).toEqual({
      aps: {
        alert: { title: "Alice", body: "Hello" },
        sound: "default",
        "thread-id": "channel-1",
      },
      ...payload.route,
    })
  })

  it.each(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"])(
    "classifies %s as an invalid device token",
    async (reason) => {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
        Response.json({ reason }, { status: 400 })
      ))
      await expect(sendApnsNotification(input(), {
        fetch: fetchMock as typeof fetch,
        getProviderToken: vi.fn(async () => "signed-token"),
      })).resolves.toEqual({ outcome: "invalid-token" })
    },
  )

  it("throws a token-free provider error for other failures", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ reason: "TooManyRequests" }, { status: 429 })
    ))
    const result = sendApnsNotification(input(), {
      fetch: fetchMock as typeof fetch,
      getProviderToken: vi.fn(async () => "signed-token"),
    })
    await expect(result).rejects.toEqual(expect.objectContaining<Partial<PushProviderError>>({
      provider: "apns",
      status: 429,
      reason: "TooManyRequests",
    }))
    await expect(result).rejects.not.toThrow(/provider-token|Hello/)
  })

  it("reuses one provider token across device/topic/environment sends until refresh", async () => {
    let now = 1_700_000_000_000
    const createProviderToken = vi.fn(async (_config, issuedAt = 0) => (
      `signed-${issuedAt}`
    ))
    const getProviderToken = createApnsProviderTokenProvider({
      createProviderToken,
      now: () => now,
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 200 })
    ))
    const dependencies = { fetch: fetchMock as typeof fetch, getProviderToken }

    await sendApnsNotification(input(), dependencies)
    now += 20 * 60 * 1000
    await sendApnsNotification({
      ...input("sandbox"),
      providerToken: "provider-token-2",
      config: { ...input().config, topic: "app.other" },
    }, dependencies)
    now += 29 * 60 * 1000
    await sendApnsNotification({ ...input(), providerToken: "provider-token-3" }, dependencies)
    expect(createProviderToken).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.map(([, init]) => (
      (init?.headers as Record<string, string>).authorization
    ))).toEqual([
      "bearer signed-1700000000000",
      "bearer signed-1700000000000",
      "bearer signed-1700000000000",
    ])

    now += 60 * 1000
    await sendApnsNotification(input(), dependencies)
    expect(createProviderToken).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[3]![1]?.headers as Record<string, string>).authorization)
      .toBe("bearer signed-1700003000000")
  })

  it("single-flights concurrent device sends through one provider-token signature", async () => {
    let releaseSignature: ((token: string) => void) | undefined
    const createProviderToken = vi.fn(() => new Promise<string>((resolve) => {
      releaseSignature = resolve
    }))
    const getProviderToken = createApnsProviderTokenProvider({
      createProviderToken,
      now: () => 1_700_000_000_000,
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 200 })
    ))
    const dependencies = { fetch: fetchMock as typeof fetch, getProviderToken }

    const sends = Promise.all([
      sendApnsNotification(input(), dependencies),
      sendApnsNotification({ ...input(), providerToken: "provider-token-2" }, dependencies),
      sendApnsNotification({ ...input(), providerToken: "provider-token-3" }, dependencies),
    ])
    await vi.waitFor(() => expect(createProviderToken).toHaveBeenCalledTimes(1))
    expect(fetchMock).not.toHaveBeenCalled()
    releaseSignature?.("shared-token")
    await expect(sends).resolves.toEqual([
      { outcome: "sent" },
      { outcome: "sent" },
      { outcome: "sent" },
    ])
    expect(createProviderToken).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.map(([, init]) => (
      (init?.headers as Record<string, string>).authorization
    ))).toEqual([
      "bearer shared-token",
      "bearer shared-token",
      "bearer shared-token",
    ])
  })

  it("keeps A and B cached independently across sequential A-B-A sends", async () => {
    const createProviderToken = vi.fn(async (config) => `signed-${config.keyId}`)
    const getProviderToken = createApnsProviderTokenProvider({ createProviderToken })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 200 })
    ))
    const dependencies = { fetch: fetchMock as typeof fetch, getProviderToken }
    const credentialA = input()
    const credentialB = {
      ...input(),
      config: { ...input().config, keyId: "test-key-b" },
    }

    await sendApnsNotification(credentialA, dependencies)
    await sendApnsNotification(credentialB, dependencies)
    await sendApnsNotification({ ...credentialA, providerToken: "provider-token-2" }, dependencies)

    expect(createProviderToken).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([, init]) => (
      (init?.headers as Record<string, string>).authorization
    ))).toEqual([
      "bearer signed-test-key",
      "bearer signed-test-key-b",
      "bearer signed-test-key",
    ])
  })

  it("keeps per-credential single-flights across concurrent A-B-A sends", async () => {
    const releaseByKey = new Map<string, (token: string) => void>()
    const createProviderToken = vi.fn((config) => new Promise<string>((resolve) => {
      releaseByKey.set(config.keyId, resolve)
    }))
    const getProviderToken = createApnsProviderTokenProvider({ createProviderToken })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 200 })
    ))
    const dependencies = { fetch: fetchMock as typeof fetch, getProviderToken }
    const credentialA = input()
    const credentialB = {
      ...input(),
      providerToken: "provider-token-b",
      config: { ...input().config, keyId: "test-key-b" },
    }

    const sends = [
      sendApnsNotification(credentialA, dependencies),
      sendApnsNotification(credentialB, dependencies),
      sendApnsNotification({ ...credentialA, providerToken: "provider-token-a2" }, dependencies),
    ]
    await vi.waitFor(() => expect(createProviderToken).toHaveBeenCalledTimes(2))
    expect(fetchMock).not.toHaveBeenCalled()
    releaseByKey.get("test-key")?.("signed-a")
    releaseByKey.get("test-key-b")?.("signed-b")
    await expect(Promise.all(sends)).resolves.toEqual([
      { outcome: "sent" },
      { outcome: "sent" },
      { outcome: "sent" },
    ])
    expect(createProviderToken.mock.calls.map(([config]) => config.keyId).sort())
      .toEqual(["test-key", "test-key-b"])
    const authorizationByDevice = new Map(fetchMock.mock.calls.map(([url, init]) => [
      String(url).split("/").at(-1),
      (init?.headers as Record<string, string>).authorization,
    ]))
    expect(authorizationByDevice).toEqual(new Map([
      ["provider-token", "bearer signed-a"],
      ["provider-token-a2", "bearer signed-a"],
      ["provider-token-b", "bearer signed-b"],
    ]))
  })

  it("clears a failed signing flight so the next send can recover", async () => {
    let rejectSignature: ((error: Error) => void) | undefined
    const createProviderToken = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_resolve, reject) => {
        rejectSignature = reject
      }))
      .mockResolvedValueOnce("recovered-token")
    const getProviderToken = createApnsProviderTokenProvider({ createProviderToken })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 200 })
    ))
    const dependencies = { fetch: fetchMock as typeof fetch, getProviderToken }

    const failedSends = [
      sendApnsNotification(input(), dependencies),
      sendApnsNotification({ ...input(), providerToken: "provider-token-2" }, dependencies),
    ]
    await vi.waitFor(() => expect(createProviderToken).toHaveBeenCalledTimes(1))
    rejectSignature?.(new Error("signing failed"))
    const failedResults = await Promise.allSettled(failedSends)
    expect(failedResults).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ])
    await expect(sendApnsNotification(input(), dependencies)).resolves.toEqual({ outcome: "sent" })
    expect(createProviderToken).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>).authorization)
      .toBe("bearer recovered-token")
  })

  it("isolates an A signing failure from a concurrent successful B authority", async () => {
    const signingA = deferred<string>()
    const signingB = deferred<string>()
    let aAttempts = 0
    const createProviderToken = vi.fn((config) => {
      if (config.keyId === "key-a") {
        aAttempts += 1
        return aAttempts === 1 ? signingA.promise : Promise.resolve("token-a-recovered")
      }
      return signingB.promise
    })
    const getProviderToken = createApnsProviderTokenProvider({
      createFingerprint: async (config) => config.keyId,
      createProviderToken,
    })
    const configA = { ...input().config, keyId: "key-a" }
    const configB = { ...input().config, keyId: "key-b" }

    const firstA = getProviderToken(configA)
    const firstB = getProviderToken(configB)
    await vi.waitFor(() => expect(createProviderToken).toHaveBeenCalledTimes(2))
    signingA.reject(new Error("A signing failed"))
    signingB.resolve("token-b")

    await expect(firstA).rejects.toThrow("A signing failed")
    await expect(firstB).resolves.toBe("token-b")
    await expect(getProviderToken(configB)).resolves.toBe("token-b")
    await expect(getProviderToken(configA)).resolves.toBe("token-a-recovered")
    expect(createProviderToken.mock.calls.map(([config]) => config.keyId))
      .toEqual(["key-a", "key-b", "key-a"])
  })

  it("refreshes at 50 minutes with one same-authority signing flight", async () => {
    const issuedAt = 1_700_000_000_000
    let now = issuedAt
    const refresh = deferred<string>()
    const createProviderToken = vi.fn()
      .mockResolvedValueOnce("initial-token")
      .mockImplementationOnce(() => refresh.promise)
    const getProviderToken = createApnsProviderTokenProvider({
      createFingerprint: async (config) => config.keyId,
      createProviderToken,
      now: () => now,
    })
    const config = input().config

    await expect(getProviderToken(config)).resolves.toBe("initial-token")
    now = issuedAt + (50 * 60 * 1000) - 1
    await expect(getProviderToken(config)).resolves.toBe("initial-token")
    expect(createProviderToken).toHaveBeenCalledTimes(1)

    now += 1
    const refreshes = [
      getProviderToken(config),
      getProviderToken(config),
      getProviderToken(config),
    ]
    await vi.waitFor(() => expect(createProviderToken).toHaveBeenCalledTimes(2))
    refresh.resolve("refreshed-token")
    await expect(Promise.all(refreshes)).resolves.toEqual([
      "refreshed-token",
      "refreshed-token",
      "refreshed-token",
    ])
    expect(createProviderToken).toHaveBeenCalledTimes(2)
  })

  it("falls back after refresh failure only while the prior token is under 60 minutes", async () => {
    const issuedAt = 1_700_000_000_000
    let now = issuedAt
    const createProviderToken = vi.fn()
      .mockResolvedValueOnce("initial-token")
      .mockRejectedValueOnce(new Error("refresh failed before expiry"))
      .mockRejectedValueOnce(new Error("refresh failed at expiry"))
    const getProviderToken = createApnsProviderTokenProvider({
      createFingerprint: async (config) => config.keyId,
      createProviderToken,
      now: () => now,
    })

    await expect(getProviderToken(input().config)).resolves.toBe("initial-token")
    now = issuedAt + (60 * 60 * 1000) - 1
    await expect(Promise.all([
      getProviderToken(input().config),
      getProviderToken(input().config),
    ])).resolves.toEqual(["initial-token", "initial-token"])

    now += 1
    await expect(getProviderToken(input().config)).rejects.toThrow("refresh failed at expiry")
    expect(createProviderToken).toHaveBeenCalledTimes(3)
  })

  it("does not fall back when a pending refresh crosses the 60-minute boundary", async () => {
    const issuedAt = 1_700_000_000_000
    let now = issuedAt
    const refresh = deferred<string>()
    const createProviderToken = vi.fn()
      .mockResolvedValueOnce("initial-token")
      .mockImplementationOnce(() => refresh.promise)
    const getProviderToken = createApnsProviderTokenProvider({
      createFingerprint: async (config) => config.keyId,
      createProviderToken,
      now: () => now,
    })

    await getProviderToken(input().config)
    now = issuedAt + (60 * 60 * 1000) - 1
    const refreshing = getProviderToken(input().config)
    await vi.waitFor(() => expect(createProviderToken).toHaveBeenCalledTimes(2))
    now += 1
    refresh.reject(new Error("late refresh failure"))

    await expect(refreshing).rejects.toThrow("late refresh failure")
  })

  it("never evicts valid authorities under cache-capacity pressure", async () => {
    const issuedAt = 1_700_000_000_000
    let now = issuedAt
    const createProviderToken = vi.fn(async (config) => `token-${config.keyId}`)
    const getProviderToken = createApnsProviderTokenProvider({
      createFingerprint: async (config) => config.keyId,
      createProviderToken,
      now: () => now,
    })
    const configs = Array.from({ length: 8 }, (_, index) => ({
      ...input().config,
      keyId: `key-${index}`,
    }))

    await Promise.all(configs.map(getProviderToken))
    now += (50 * 60 * 1000) - 1
    await expect(Promise.all(configs.map(getProviderToken))).resolves.toEqual(
      configs.map((config) => `token-${config.keyId}`),
    )
    expect(createProviderToken).toHaveBeenCalledTimes(configs.length)
  })

  it("never evicts in-flight authorities under capacity pressure", async () => {
    const signingByKey = new Map<string, ReturnType<typeof deferred<string>>>()
    const createProviderToken = vi.fn((config) => {
      const signing = deferred<string>()
      signingByKey.set(config.keyId, signing)
      return signing.promise
    })
    const getProviderToken = createApnsProviderTokenProvider({
      createFingerprint: async (config) => config.keyId,
      createProviderToken,
    })
    const configs = Array.from({ length: 8 }, (_, index) => ({
      ...input().config,
      keyId: `key-${index}`,
    }))
    const calls = [
      ...configs.map(getProviderToken),
      ...configs.map(getProviderToken),
    ]
    const settled = Promise.all(calls)
    await vi.waitFor(() => expect(createProviderToken).toHaveBeenCalledTimes(configs.length))

    for (const config of configs) {
      signingByKey.get(config.keyId)!.resolve(`token-${config.keyId}`)
    }

    await expect(settled).resolves.toEqual([
      ...configs.map((config) => `token-${config.keyId}`),
      ...configs.map((config) => `token-${config.keyId}`),
    ])
    expect(createProviderToken).toHaveBeenCalledTimes(configs.length)
  })

  it("treats clock rollback as zero age instead of signing early", async () => {
    const issuedAt = 1_700_000_000_000
    let now = issuedAt
    const createProviderToken = vi.fn(async () => "initial-token")
    const getProviderToken = createApnsProviderTokenProvider({
      createFingerprint: async (config) => config.keyId,
      createProviderToken,
      now: () => now,
    })

    await expect(getProviderToken(input().config)).resolves.toBe("initial-token")
    now -= 5 * 60 * 1000
    await expect(getProviderToken(input().config)).resolves.toBe("initial-token")
    expect(createProviderToken).toHaveBeenCalledTimes(1)
  })

  it("keys authority by credentials but not by topic", async () => {
    const createProviderToken = vi.fn(async (config) => (
      `token-${config.teamId}-${config.keyId}-${config.privateKey}`
    ))
    const getProviderToken = createApnsProviderTokenProvider({ createProviderToken })
    const base = input().config
    const differentTopic = { ...base, topic: "app.other" }
    const escapedNewlines = { ...base, privateKey: base.privateKey.replace(/\n/gu, "\\n") }
    const differentPrivateKey = {
      ...base,
      privateKey: "-----BEGIN PRIVATE KEY-----\nb3RoZXI=\n-----END PRIVATE KEY-----",
    }

    const tokens = await Promise.all([
      getProviderToken(base),
      getProviderToken(differentTopic),
      getProviderToken(escapedNewlines),
      getProviderToken({ ...base, teamId: "team-other" }),
      getProviderToken({ ...base, keyId: "key-other" }),
      getProviderToken(differentPrivateKey),
    ])

    expect(tokens[0]).toBe(tokens[1])
    expect(tokens[0]).toBe(tokens[2])
    expect(new Set(tokens).size).toBe(4)
    expect(createProviderToken).toHaveBeenCalledTimes(4)
  })

  it("preserves authority ownership across bounded A-B settlement permutations", async () => {
    const settlementOrders = [
      ["key-a", "key-b"],
      ["key-b", "key-a"],
    ] as const
    const failureSets: readonly (readonly string[])[] = [
      [],
      ["key-a"],
      ["key-b"],
      ["key-a", "key-b"],
    ]

    for (const settlementOrder of settlementOrders) {
      for (const failureKeys of failureSets) {
        const signingByKey = new Map([
          ["key-a", deferred<string>()],
          ["key-b", deferred<string>()],
        ])
        const createProviderToken = vi.fn((config) => signingByKey.get(config.keyId)!.promise)
        const getProviderToken = createApnsProviderTokenProvider({
          createFingerprint: async (config) => config.keyId,
          createProviderToken,
        })
        const configA = { ...input().config, keyId: "key-a" }
        const configB = { ...input().config, keyId: "key-b" }
        const requestedKeys = ["key-a", "key-b", "key-a", "key-b"] as const
        const calls = [
          getProviderToken(configA),
          getProviderToken(configB),
          getProviderToken(configA),
          getProviderToken(configB),
        ]
        const settled = Promise.allSettled(calls)
        await vi.waitFor(() => expect(createProviderToken).toHaveBeenCalledTimes(2))

        for (const key of settlementOrder) {
          const signing = signingByKey.get(key)!
          if (failureKeys.includes(key)) signing.reject(new Error(`${key} failed`))
          else signing.resolve(`token-${key}`)
        }

        const results = await settled
        for (const [index, result] of results.entries()) {
          const key = requestedKeys[index]!
          if (failureKeys.includes(key)) {
            expect(result.status).toBe("rejected")
          } else {
            expect(result).toEqual({ status: "fulfilled", value: `token-${key}` })
          }
        }
        expect(createProviderToken.mock.calls.map(([config]) => config.keyId).sort())
          .toEqual(["key-a", "key-b"])
      }
    }
  })
})
