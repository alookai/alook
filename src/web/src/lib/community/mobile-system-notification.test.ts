import { describe, expect, it, vi } from "vitest"
import {
  createMobileSystemNotificationActivationController,
  createMobileSystemNotificationRegistrationController,
  deleteMobileSystemNotificationRegistration,
  parseMobileSystemNotificationActivation,
  parseMobileSystemNotificationPermission,
  parseMobileSystemNotificationRegistration,
  postMobileSystemNotificationRegistration,
  revalidateMobileSystemNotificationActivation,
  resumeMobileSystemNotificationRegistration,
  suspendMobileSystemNotificationRegistration,
  type MobileSystemNotificationRegistration,
  type MobileSystemNotificationRegistrationDeps,
} from "./mobile-system-notification"

const installationId = "123e4567-e89b-42d3-a456-426614174000"
const notificationId = "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e"
const token0 = "token-00000000000"
const token1 = "token-11111111111"
const token2 = "token-22222222222"

function snapshot(
  overrides: Partial<MobileSystemNotificationRegistration> = {},
): MobileSystemNotificationRegistration {
  return {
    installationId,
    platform: "ios",
    providerEnvironment: "sandbox",
    providerToken: token0,
    appVersion: "0.1.36",
    ...overrides,
  }
}

function registrationDeps(
  overrides: Partial<MobileSystemNotificationRegistrationDeps> = {},
): MobileSystemNotificationRegistrationDeps {
  return {
    checkPermission: vi.fn(async () => "granted"),
    requestPermission: vi.fn(async () => "granted"),
    snapshot: vi.fn(async () => snapshot()),
    register: vi.fn(async () => undefined),
    acknowledge: vi.fn(async () => undefined),
    unregister: vi.fn(async () => undefined),
    schedule: vi.fn(() => 1),
    cancel: vi.fn(),
    ...overrides,
  }
}

describe("mobile notification native value parsing", () => {
  it("accepts only exact permission and registration shapes", () => {
    expect(parseMobileSystemNotificationPermission({ permissionState: "granted" })).toBe("granted")
    expect(parseMobileSystemNotificationPermission({ permissionState: "granted", token: token0 })).toBeNull()
    expect(parseMobileSystemNotificationPermission({ permissionState: "unknown" })).toBeNull()

    const value = {
      installationId,
      platform: "ios",
      providerEnvironment: "sandbox",
      providerToken: token0,
      previousProviderToken: token1,
      appVersion: "0.1.36",
    }
    expect(parseMobileSystemNotificationRegistration(value)).toEqual(value)
    expect(parseMobileSystemNotificationRegistration({ ...value, secret: token2 })).toBeNull()
    expect(parseMobileSystemNotificationRegistration({
      ...value,
      platform: "android",
      providerEnvironment: "sandbox",
    })).toBeNull()
    expect(parseMobileSystemNotificationRegistration({
      ...value,
      previousProviderToken: token0,
    })).toBeNull()
  })

  it("accepts only the flat allowlisted activation", () => {
    const activation = { notificationId, messageId: "message_1", targetId: "channel_1" }
    expect(parseMobileSystemNotificationActivation(activation)).toEqual(activation)
    expect(parseMobileSystemNotificationActivation({ ...activation, serverId: "server_1" })).toBeNull()
    expect(parseMobileSystemNotificationActivation({ ...activation, messageId: "../message" })).toBeNull()
    expect(parseMobileSystemNotificationActivation({ ...activation, notificationId: "bad" })).toBeNull()
  })
})

describe("mobile notification HTTP adapter", () => {
  it("posts the exact registration with same-origin cookies", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ device: {} }), { status: 200 }))
    await postMobileSystemNotificationRegistration(snapshot({ previousProviderToken: token1 }), fetchImpl)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("/api/community/notifications/devices")
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      installationId,
      platform: "ios",
      providerEnvironment: "sandbox",
      providerToken: token0,
      previousProviderToken: token1,
      appVersion: "0.1.36",
    })
  })

  it("deletes the encoded installation and rejects failed responses", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    await deleteMobileSystemNotificationRegistration(installationId, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/community/notifications/devices/${installationId}`,
      { method: "DELETE", credentials: "same-origin" },
    )

    await expect(postMobileSystemNotificationRegistration(
      snapshot(),
      vi.fn(async () => new Response(null, { status: 409 })),
    )).rejects.toThrow("registration_failed")
  })

  it("orders logout deletion after an active POST and suppresses later registration", async () => {
    const calls: string[] = []
    let releasePost = () => undefined
    const blockedPost = new Promise<void>((resolve) => { releasePost = resolve })
    const post = postMobileSystemNotificationRegistration(snapshot(), async () => {
      calls.push("post:start")
      await blockedPost
      calls.push("post:end")
      return new Response(null, { status: 204 })
    })
    await vi.waitFor(() => expect(calls).toEqual(["post:start"]))

    suspendMobileSystemNotificationRegistration()
    const remove = deleteMobileSystemNotificationRegistration(installationId, async () => {
      calls.push("delete")
      return new Response(null, { status: 204 })
    })
    releasePost()
    await Promise.all([post, remove])
    expect(calls).toEqual(["post:start", "post:end", "delete"])

    const suppressedFetch = vi.fn()
    await expect(postMobileSystemNotificationRegistration(
      snapshot(),
      suppressedFetch,
    )).rejects.toThrow("registration_suspended")
    expect(suppressedFetch).not.toHaveBeenCalled()
    resumeMobileSystemNotificationRegistration()
  })
})

describe("mobile notification registration controller", () => {
  it("requests permission once, posts, then acknowledges the exact sent token", async () => {
    const calls: string[] = []
    const deps = registrationDeps({
      checkPermission: vi.fn(async () => { calls.push("check"); return "prompt" }),
      requestPermission: vi.fn(async () => { calls.push("request"); return "granted" }),
      snapshot: vi.fn(async () => { calls.push("snapshot"); return snapshot() }),
      register: vi.fn(async () => { calls.push("post") }),
      acknowledge: vi.fn(async (token) => { calls.push(`ack:${token}`) }),
    })
    const controller = createMobileSystemNotificationRegistrationController(deps)
    await controller.sync(true)
    expect(calls).toEqual(["check", "request", "snapshot", "post", `ack:${token0}`])
  })

  it("disables a denied installation and waits for a native signal when no token exists", async () => {
    const denied = registrationDeps({
      checkPermission: vi.fn(async () => "denied"),
    })
    await createMobileSystemNotificationRegistrationController(denied).sync(true)
    expect(denied.unregister).toHaveBeenCalledWith(installationId)
    expect(denied.register).not.toHaveBeenCalled()

    const tokenless = registrationDeps({
      snapshot: vi.fn(async () => snapshot({ providerToken: undefined })),
    })
    await createMobileSystemNotificationRegistrationController(tokenless).sync()
    expect(tokenless.register).not.toHaveBeenCalled()
    expect(tokenless.schedule).not.toHaveBeenCalled()
  })

  it("serializes concurrent signals and coalesces them into one rerun", async () => {
    let release = () => undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let concurrent = 0
    let peak = 0
    const deps = registrationDeps({
      register: vi.fn(async () => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await blocked
        concurrent -= 1
      }),
    })
    const controller = createMobileSystemNotificationRegistrationController(deps)
    const first = controller.sync()
    await vi.waitFor(() => expect(deps.register).toHaveBeenCalledOnce())
    const second = controller.sync()
    const third = controller.sync()
    expect(second).toBe(first)
    expect(third).toBe(first)
    release()
    await first
    expect(deps.register).toHaveBeenCalledTimes(2)
    expect(peak).toBe(1)
  })

  it("retains the last acknowledged token across failed rotations", async () => {
    let currentToken = token0
    let acknowledgedToken: string | undefined
    const posted: MobileSystemNotificationRegistration[] = []
    let retry: (() => void) | undefined
    const deps = registrationDeps({
      snapshot: vi.fn(async () => snapshot({
        providerToken: currentToken,
        previousProviderToken: acknowledgedToken === currentToken ? undefined : acknowledgedToken,
      })),
      register: vi.fn(async (value) => {
        posted.push(value)
        if (value.providerToken === token1) throw new Error("offline")
      }),
      acknowledge: vi.fn(async (token) => {
        if (token !== currentToken) throw new Error("stale")
        acknowledgedToken = token
      }),
      schedule: vi.fn((callback) => { retry = callback; return 7 }),
    })
    const controller = createMobileSystemNotificationRegistrationController(deps)
    await controller.sync()
    currentToken = token1
    await controller.sync()
    expect(retry).toBeTypeOf("function")
    currentToken = token2
    await controller.sync()
    expect(posted.map(({ providerToken, previousProviderToken }) => ({
      providerToken,
      previousProviderToken,
    }))).toEqual([
      { providerToken: token0, previousProviderToken: undefined },
      { providerToken: token1, previousProviderToken: token0 },
      { providerToken: token2, previousProviderToken: token0 },
    ])
    expect(acknowledgedToken).toBe(token2)
    expect(deps.cancel).toHaveBeenCalledWith(7)
  })

  it("uses bounded retry delays and cancels a pending retry on disposal", async () => {
    const scheduled: Array<{ callback: () => void; delay: number }> = []
    const deps = registrationDeps({
      checkPermission: vi.fn(async () => { throw new Error("offline") }),
      schedule: vi.fn((callback, delay) => {
        scheduled.push({ callback, delay })
        return scheduled.length
      }),
      retryDelaysMs: [10, 20],
    })
    const controller = createMobileSystemNotificationRegistrationController(deps)
    await controller.sync(true)
    expect(scheduled.map(({ delay }) => delay)).toEqual([10])
    scheduled.shift()?.callback()
    await vi.waitFor(() => expect(scheduled.map(({ delay }) => delay)).toEqual([20]))
    scheduled.shift()?.callback()
    await vi.waitFor(() => expect(deps.checkPermission).toHaveBeenCalledTimes(3))
    expect(scheduled).toHaveLength(0)

    const disposableDeps = registrationDeps({
      checkPermission: vi.fn(async () => { throw new Error("offline") }),
    })
    const disposable = createMobileSystemNotificationRegistrationController(disposableDeps)
    disposable.dispose()
    await disposable.sync()
    expect(disposableDeps.checkPermission).not.toHaveBeenCalled()
  })
})

describe("mobile notification activation", () => {
  const activation = { notificationId, messageId: "message_1", targetId: "channel_1" }

  it("navigates only after exact DM and server revalidation", async () => {
    const dmFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [{ id: "message_1", seq: 9 }],
        surfaceReceipt: { channelId: "channel_1", surfaceKind: "dm" },
      })))
    await expect(revalidateMobileSystemNotificationActivation(activation, dmFetch)).resolves.toEqual({
      href: "/c/me/channel_1?seq=9",
    })

    const serverFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [{ id: "message_1", seq: 9 }],
        surfaceReceipt: { channelId: "channel_1", surfaceKind: "thread" },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "channel_1",
        serverId: "server_1",
        type: "thread",
      })))
    await expect(revalidateMobileSystemNotificationActivation(activation, serverFetch)).resolves.toEqual({
      href: "/c/channels/server_1/channel_1?msg=message_1",
    })
    expect(serverFetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/community/channels/channel_1/messages?anchor=message_1&limit=1",
      "/api/community/channels/channel_1",
    ])
  })

  it.each([
    ["deleted", new Response(null, { status: 404 })],
    ["revoked", new Response(null, { status: 403 })],
    ["wrong message", new Response(JSON.stringify({
      messages: [{ id: "other", seq: 9 }],
      surfaceReceipt: { channelId: "channel_1", surfaceKind: "dm" },
    }))],
    ["wrong target", new Response(JSON.stringify({
      messages: [{ id: "message_1", seq: 9 }],
      surfaceReceipt: { channelId: "other", surfaceKind: "dm" },
    }))],
    ["receipt extras", new Response(JSON.stringify({
      messages: [{ id: "message_1", seq: 9 }],
      surfaceReceipt: { channelId: "channel_1", surfaceKind: "dm", secret: true },
    }))],
  ])("falls back for %s message-door results", async (_label, response) => {
    await expect(revalidateMobileSystemNotificationActivation(
      activation,
      vi.fn(async () => response),
    )).resolves.toBeNull()
  })

  it("opens Inbox on invalid, revoked, or unreadable activations", async () => {
    const openInbox = vi.fn()
    const navigate = vi.fn()
    const controller = createMobileSystemNotificationActivationController({
      take: vi.fn()
        .mockResolvedValueOnce(activation)
        .mockRejectedValueOnce(new Error("invalid native response")),
      revalidate: vi.fn(async () => null),
      navigate,
      openInbox,
    })
    await controller.drain()
    await controller.drain()
    expect(openInbox).toHaveBeenCalledTimes(2)
    expect(navigate).not.toHaveBeenCalled()
  })
})
