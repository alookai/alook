import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import {
  createDesktopSystemNotificationActivationController,
  createDesktopSystemNotificationInboxOpener,
  type DesktopSystemNotificationInboxDeps,
  useNativeSystemNotifications,
} from "./use-native-system-notifications"
import type { DesktopSystemNotificationActivation } from "@/lib/community/system-notification-route"

const hookMocks = vi.hoisted(() => ({
  desktop: true,
  mobile: false,
  listen: vi.fn(),
  take: vi.fn(),
  revalidate: vi.fn(),
  mobileListen: vi.fn(),
  mobileCheck: vi.fn(),
  mobileRequest: vi.fn(),
  mobileSnapshot: vi.fn(),
  mobilePost: vi.fn(),
  mobileAck: vi.fn(),
  mobileDelete: vi.fn(),
  mobileTake: vi.fn(),
  mobileRevalidate: vi.fn(),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    isDesktop: () => hookMocks.desktop,
    isMobile: () => hookMocks.mobile,
  }
})
vi.mock("@/lib/community/desktop-system-notification", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/desktop-system-notification")>(
    "@/lib/community/desktop-system-notification",
  )
  return {
    ...actual,
    listenDesktopSystemNotificationActivations: hookMocks.listen,
    takeDesktopSystemNotificationActivation: hookMocks.take,
  }
})
vi.mock("@/lib/community/system-notification-route", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/system-notification-route")>(
    "@/lib/community/system-notification-route",
  )
  return { ...actual, revalidateDesktopSystemNotificationTarget: hookMocks.revalidate }
})
vi.mock("@/lib/community/mobile-system-notification", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/mobile-system-notification")>(
    "@/lib/community/mobile-system-notification",
  )
  return {
    ...actual,
    listenMobileSystemNotificationSignals: hookMocks.mobileListen,
    checkMobileSystemNotificationPermission: hookMocks.mobileCheck,
    requestMobileSystemNotificationPermission: hookMocks.mobileRequest,
    snapshotMobileSystemNotificationRegistration: hookMocks.mobileSnapshot,
    postMobileSystemNotificationRegistration: hookMocks.mobilePost,
    acknowledgeMobileSystemNotificationRegistration: hookMocks.mobileAck,
    deleteMobileSystemNotificationRegistration: hookMocks.mobileDelete,
    takeMobileSystemNotificationActivation: hookMocks.mobileTake,
    revalidateMobileSystemNotificationActivation: hookMocks.mobileRevalidate,
  }
})

const activation: DesktopSystemNotificationActivation = {
  notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
  target: {
    kind: "server",
    serverId: "server_1",
    channelId: "channel_1",
    messageId: "message_1",
    seq: 4,
  },
}

afterEach(() => {
  hookMocks.desktop = true
  hookMocks.mobile = false
  window.sessionStorage.clear()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("desktop notification activation controller", () => {
  it("drains a cold-start activation after registering the listener", async () => {
    const calls: string[] = []
    const controller = createDesktopSystemNotificationActivationController({
      listen: vi.fn(async () => { calls.push("listen"); return () => calls.push("unlisten") }),
      take: vi.fn(async () => { calls.push("take"); return activation }),
      revalidate: vi.fn(async () => { calls.push("revalidate"); return true }),
      navigate: vi.fn(() => calls.push("navigate")),
      openInbox: vi.fn(),
    })
    await controller.connect()
    expect(calls).toEqual(["listen", "take", "revalidate", "navigate"])
    controller.dispose()
    expect(calls.at(-1)).toBe("unlisten")
  })

  it("falls back to Inbox when the message is deleted or access is revoked", async () => {
    const openInbox = vi.fn()
    const navigate = vi.fn()
    const controller = createDesktopSystemNotificationActivationController({
      listen: vi.fn(async () => () => undefined),
      take: vi.fn(async () => activation),
      revalidate: vi.fn(async () => false),
      navigate,
      openInbox,
    })
    await controller.connect()
    expect(openInbox).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("handles hot activation signals and ignores work after disposal", async () => {
    let ready: (() => void) | undefined
    const take = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(activation)
      .mockResolvedValue(null)
    const navigate = vi.fn()
    const controller = createDesktopSystemNotificationActivationController({
      listen: vi.fn(async (callback) => { ready = callback; return () => undefined }),
      take,
      revalidate: vi.fn(async () => true),
      navigate,
      openInbox: vi.fn(),
    })
    await controller.connect()
    ready?.()
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce())
    controller.dispose()
    ready?.()
    await Promise.resolve()
    expect(take).toHaveBeenCalledTimes(2)
  })

  it("reruns a drain when a native signal arrives during an active take", async () => {
    let ready: (() => void) | undefined
    let releaseTake = (_value: DesktopSystemNotificationActivation | null) => undefined
    const firstTake = new Promise<DesktopSystemNotificationActivation | null>((resolve) => {
      releaseTake = resolve
    })
    const take = vi.fn()
      .mockReturnValueOnce(firstTake)
      .mockResolvedValueOnce(null)
    const controller = createDesktopSystemNotificationActivationController({
      listen: vi.fn(async (callback) => { ready = callback; return () => undefined }),
      take,
      revalidate: vi.fn(async () => true),
      navigate: vi.fn(),
      openInbox: vi.fn(),
    })

    const connecting = controller.connect()
    await waitFor(() => expect(take).toHaveBeenCalledOnce())
    ready?.()
    releaseTake(null)
    await connecting
    expect(take).toHaveBeenCalledTimes(2)
  })

  it("stops a listener that resolves after disposal", async () => {
    let releaseListen = (_stop: () => void) => undefined
    const listener = new Promise<() => void>((resolve) => { releaseListen = resolve })
    const stop = vi.fn()
    const controller = createDesktopSystemNotificationActivationController({
      listen: vi.fn(() => listener),
      take: vi.fn(),
      revalidate: vi.fn(),
      navigate: vi.fn(),
      openInbox: vi.fn(),
    })

    const connecting = controller.connect()
    controller.dispose()
    releaseListen(stop)
    await connecting
    expect(stop).toHaveBeenCalledOnce()
  })
})

function inboxDeps(
  pending: Map<string, string>,
  overrides: Partial<DesktopSystemNotificationInboxDeps> = {},
): DesktopSystemNotificationInboxDeps {
  return {
    getItem: (key) => pending.get(key) ?? null,
    setItem: (key, value) => pending.set(key, value),
    removeItem: (key) => { pending.delete(key) },
    findTrigger: () => null,
    navigateToCommunity: vi.fn(),
    wait: async () => undefined,
    now: () => 1_000,
    pollAttempts: 2,
    ...overrides,
  }
}

describe("desktop notification Inbox fallback", () => {
  it("keeps a timed-out intent for remount, navigates once, and clears only after a real click", async () => {
    const pending = new Map<string, string>()
    const firstNavigate = vi.fn()
    const first = createDesktopSystemNotificationInboxOpener(inboxDeps(pending, {
      navigateToCommunity: firstNavigate,
    }))

    await first.open()
    expect(firstNavigate).toHaveBeenCalledOnce()
    expect([...pending.values()].map((value) => JSON.parse(value))).toEqual([
      { version: 1, expiresAt: 301_000, navigationStarted: true },
    ])
    await first.open()
    expect(firstNavigate).toHaveBeenCalledOnce()
    first.dispose()

    const remountNavigate = vi.fn()
    const click = vi.fn()
    const remount = createDesktopSystemNotificationInboxOpener(inboxDeps(pending, {
      findTrigger: () => ({ click }),
      navigateToCommunity: remountNavigate,
    }))
    await remount.resume()
    expect(click).toHaveBeenCalledOnce()
    expect(remountNavigate).not.toHaveBeenCalled()
    expect(pending.size).toBe(0)
  })

  it("consumes a trigger that mounts late without navigating", async () => {
    const pending = new Map<string, string>()
    const click = vi.fn()
    const navigate = vi.fn()
    let probes = 0
    const opener = createDesktopSystemNotificationInboxOpener(inboxDeps(pending, {
      findTrigger: () => (++probes === 2 ? { click } : null),
      navigateToCommunity: navigate,
    }))

    await opener.open()
    expect(click).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
    expect(pending.size).toBe(0)
  })

  it("cleans corrupt or expired state and has no side effects after disposal", async () => {
    const pending = new Map([["alook:desktop-system-notification:inbox-intent", "corrupt"]])
    const navigate = vi.fn()
    const opener = createDesktopSystemNotificationInboxOpener(inboxDeps(pending, {
      navigateToCommunity: navigate,
    }))
    await opener.resume()
    expect(pending.size).toBe(0)

    pending.set("alook:desktop-system-notification:inbox-intent", JSON.stringify({
      version: 1,
      expiresAt: 999,
      navigationStarted: false,
    }))
    await opener.resume()
    expect(pending.size).toBe(0)

    let releaseWait = () => undefined
    const wait = new Promise<void>((resolve) => { releaseWait = resolve })
    const click = vi.fn()
    let triggerReady = false
    const active = createDesktopSystemNotificationInboxOpener(inboxDeps(pending, {
      findTrigger: () => (triggerReady ? { click } : null),
      navigateToCommunity: navigate,
      wait: () => wait,
    }))
    const opening = active.open()
    await Promise.resolve()
    triggerReady = true
    active.dispose()
    releaseWait()
    await opening
    expect(click).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(pending.size).toBe(1)
  })

  it("treats storage failures as unavailable persistence", async () => {
    const removeFailure = createDesktopSystemNotificationInboxOpener(inboxDeps(new Map(), {
      getItem: () => "corrupt",
      removeItem: () => { throw new Error("blocked") },
    }))
    await removeFailure.resume()

    const readFailure = createDesktopSystemNotificationInboxOpener(inboxDeps(new Map(), {
      getItem: () => { throw new Error("blocked") },
    }))
    await readFailure.resume()

    const writeFailure = createDesktopSystemNotificationInboxOpener(inboxDeps(new Map(), {
      setItem: () => { throw new Error("blocked") },
    }))
    await writeFailure.open()
  })
})

describe("native system notification hook", () => {
  it("does nothing in the browser", () => {
    hookMocks.desktop = false
    const rendered = renderHook(() => useNativeSystemNotifications("viewer_1"))
    expect(hookMocks.listen).not.toHaveBeenCalled()
    rendered.unmount()
  })

  it("navigates an allowed activation and disposes the native listener", async () => {
    const assign = vi.fn()
    const stop = vi.fn()
    vi.stubGlobal("location", { href: "https://alook.test/c", assign })
    hookMocks.listen.mockResolvedValue(stop)
    hookMocks.take.mockResolvedValueOnce(activation)
    hookMocks.revalidate.mockResolvedValue(true)

    const rendered = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await waitFor(() => expect(assign).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1?msg=message_1",
    ))
    expect(hookMocks.revalidate).toHaveBeenCalledWith(activation.target)

    rendered.unmount()
    expect(stop).toHaveBeenCalledOnce()
  })

  it("persists an Inbox fallback, resumes it, and clears it after a real click", async () => {
    vi.useFakeTimers()
    const assign = vi.fn()
    const stop = vi.fn()
    vi.stubGlobal("location", { href: "https://alook.test/c/channels/server_1/channel_1", assign })
    hookMocks.listen.mockResolvedValue(stop)
    hookMocks.take.mockResolvedValueOnce(activation).mockResolvedValue(null)
    hookMocks.revalidate.mockResolvedValue(false)

    const first = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(assign).toHaveBeenCalledWith("https://alook.test/c")
    first.unmount()

    const button = document.createElement("button")
    button.setAttribute("aria-label", "Inbox")
    const click = vi.spyOn(button, "click")
    document.body.append(button)
    const second = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await act(async () => { await Promise.resolve() })
    expect(click).toHaveBeenCalledOnce()
    expect(window.sessionStorage.length).toBe(0)
    second.unmount()
  })

  it("disposes the controller when native listener setup rejects", async () => {
    hookMocks.listen.mockRejectedValue(new Error("native unavailable"))
    hookMocks.take.mockResolvedValue(null)
    const rendered = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await act(async () => { await Promise.resolve() })
    expect(hookMocks.listen).toHaveBeenCalledOnce()
    rendered.unmount()
  })

  it("uses one mobile listener for Web-ready registration and activation signals", async () => {
    hookMocks.desktop = false
    hookMocks.mobile = true
    const calls: string[] = []
    const assign = vi.fn()
    const stop = vi.fn()
    let signal: (() => void) | undefined
    vi.stubGlobal("location", { href: "https://alook.test/c", assign })
    hookMocks.mobileListen.mockImplementation(async (callback) => {
      calls.push("listen")
      signal = callback
      return stop
    })
    hookMocks.mobileCheck.mockImplementation(async () => { calls.push("check"); return "granted" })
    hookMocks.mobileSnapshot.mockImplementation(async () => {
      calls.push("snapshot")
      return {
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        platform: "ios",
        providerEnvironment: "sandbox",
        providerToken: "token-00000000000",
      }
    })
    hookMocks.mobilePost.mockImplementation(async () => { calls.push("post") })
    hookMocks.mobileAck.mockImplementation(async () => { calls.push("ack") })
    hookMocks.mobileTake
      .mockImplementationOnce(async () => {
        calls.push("take")
        return {
          notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
          messageId: "message_1",
          targetId: "channel_1",
        }
      })
      .mockImplementationOnce(async () => {
        calls.push("take")
        return {
          notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
          messageId: "message_2",
          targetId: "channel_1",
        }
      })
      .mockImplementation(async () => { calls.push("take"); return null })
    hookMocks.mobileRevalidate
      .mockResolvedValueOnce({ href: "/c/me/channel_1?seq=9" })
      .mockResolvedValueOnce(null)

    const rendered = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await waitFor(() => expect(calls).toEqual([
      "listen",
      "check",
      "take",
      "snapshot",
      "post",
      "ack",
    ]))
    expect(hookMocks.mobileListen).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledWith("/c/me/channel_1?seq=9")

    const button = document.createElement("button")
    button.setAttribute("aria-label", "Inbox")
    const click = vi.spyOn(button, "click")
    document.body.append(button)
    const visibilityState = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    document.dispatchEvent(new Event("visibilitychange"))
    await waitFor(() => expect(hookMocks.mobileCheck).toHaveBeenCalledTimes(2))
    expect(hookMocks.mobileTake).toHaveBeenCalledTimes(2)
    expect(click).toHaveBeenCalledOnce()

    signal?.()
    await waitFor(() => expect(hookMocks.mobileCheck).toHaveBeenCalledTimes(3))
    expect(hookMocks.mobileTake).toHaveBeenCalledTimes(3)
    rendered.unmount()
    visibilityState.mockRestore()
    expect(stop).toHaveBeenCalledOnce()
  })

  it("schedules and cancels a mobile registration retry", async () => {
    hookMocks.desktop = false
    hookMocks.mobile = true
    const stop = vi.fn()
    const setTimeout = vi.spyOn(window, "setTimeout")
    const clearTimeout = vi.spyOn(window, "clearTimeout")
    hookMocks.mobileListen.mockResolvedValue(stop)
    hookMocks.mobileCheck.mockRejectedValue(new Error("offline"))
    hookMocks.mobileTake.mockResolvedValue(null)

    const rendered = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await waitFor(() => expect(setTimeout.mock.calls.some(([, delay]) => delay === 1_000)).toBe(true))
    const clearsBeforeUnmount = clearTimeout.mock.calls.length
    rendered.unmount()

    expect(clearTimeout.mock.calls).toHaveLength(clearsBeforeUnmount + 1)
    expect(stop).toHaveBeenCalledOnce()
  })

  it("continues mobile startup when native listener setup rejects", async () => {
    hookMocks.desktop = false
    hookMocks.mobile = true
    hookMocks.mobileListen.mockRejectedValue(new Error("native unavailable"))
    hookMocks.mobileCheck.mockResolvedValue("granted")
    hookMocks.mobileSnapshot.mockResolvedValue({
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      platform: "ios",
      providerEnvironment: "sandbox",
    })
    hookMocks.mobileTake.mockResolvedValue(null)

    const rendered = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await waitFor(() => expect(hookMocks.mobileCheck).toHaveBeenCalledOnce())
    expect(hookMocks.mobileTake).toHaveBeenCalledOnce()
    rendered.unmount()
  })
})
