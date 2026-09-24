import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import {
  createDesktopSystemNotificationActivationController,
  createDesktopSystemNotificationInboxOpener,
  type DesktopSystemNotificationInboxDeps,
  useNativeSystemNotifications,
} from "./use-native-system-notifications"
import type { DesktopSystemNotificationActivation } from "@/lib/community/system-notification-route"
import { createNativeSystemNotificationDismissalQueue } from "@/lib/community/native-system-notification-dismissal"

const hookMocks = vi.hoisted(() => ({
  desktop: true,
  mobile: false,
  listen: vi.fn(),
  take: vi.fn(),
  retryActivation: vi.fn(async () => undefined),
  dismiss: vi.fn(async () => undefined),
  revalidate: vi.fn(),
  mobileListen: vi.fn(),
  mobileCheck: vi.fn(),
  mobileRequest: vi.fn(),
  mobileSnapshot: vi.fn(),
  mobilePost: vi.fn(),
  mobileAck: vi.fn(),
  mobileDelete: vi.fn(),
  mobileTake: vi.fn(),
  mobileDismiss: vi.fn(async () => undefined),
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
    retryDesktopSystemNotificationActivation: hookMocks.retryActivation,
    dismissDesktopSystemNotification: hookMocks.dismiss,
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
    dismissMobileSystemNotification: hookMocks.mobileDismiss,
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
      revalidate: vi.fn(async () => { calls.push("revalidate"); return "allowed" as const }),
      retryActivation: vi.fn(),
      queueDismiss: vi.fn(() => { calls.push("queueDismiss") }),
      navigate: vi.fn(() => calls.push("navigate")),
      openInbox: vi.fn(),
    })
    await controller.connect()
    expect(calls).toEqual(["listen", "take", "revalidate", "queueDismiss", "navigate"])
    controller.dispose()
    expect(calls.at(-1)).toBe("unlisten")
  })

  it("falls back to Inbox when the message is deleted or access is revoked", async () => {
    const openInbox = vi.fn()
    const navigate = vi.fn()
    const retryActivation = vi.fn()
    const controller = createDesktopSystemNotificationActivationController({
      listen: vi.fn(async () => () => undefined),
      take: vi.fn(async () => activation),
      revalidate: vi.fn(async () => "invalid" as const),
      retryActivation,
      queueDismiss: vi.fn(),
      navigate,
      openInbox,
    })
    await controller.connect()
    expect(openInbox).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
    expect(retryActivation).not.toHaveBeenCalled()
  })

  it("re-arms only a retryable activation before falling back to Inbox", async () => {
    const calls: string[] = []
    const retryActivation = vi.fn(async (notificationId: string) => {
      calls.push(`retry:${notificationId}`)
    })
    const controller = createDesktopSystemNotificationActivationController({
      listen: vi.fn(async () => () => undefined),
      take: vi.fn(async () => activation),
      revalidate: vi.fn(async () => {
        calls.push("revalidate")
        return "retryable" as const
      }),
      retryActivation,
      queueDismiss: vi.fn(),
      navigate: vi.fn(),
      openInbox: vi.fn(async () => { calls.push("inbox") }),
    })

    await controller.connect()
    expect(calls).toEqual([
      "revalidate",
      `retry:${activation.notificationId}`,
      "inbox",
    ])
  })

  it("still navigates when dismissal persistence fails", async () => {
    const navigate = vi.fn()
    const controller = createDesktopSystemNotificationActivationController({
      listen: vi.fn(async () => () => undefined),
      take: vi.fn(async () => activation),
      revalidate: vi.fn(async () => "allowed" as const),
      retryActivation: vi.fn(),
      queueDismiss: vi.fn(() => { throw new Error("storage unavailable") }),
      navigate,
      openInbox: vi.fn(),
    })
    await controller.connect()
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/c/channels/server_1/channel_1")
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
      revalidate: vi.fn(async () => "allowed" as const),
      retryActivation: vi.fn(),
      queueDismiss: vi.fn(),
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
      revalidate: vi.fn(async () => "allowed" as const),
      retryActivation: vi.fn(),
      queueDismiss: vi.fn(),
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
      retryActivation: vi.fn(),
      queueDismiss: vi.fn(),
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

  it("dismisses on the loaded destination and retries a transient native failure", async () => {
    const assign = vi.fn()
    const stop = vi.fn()
    vi.stubGlobal("location", { href: "https://alook.test/c", assign })
    hookMocks.listen.mockResolvedValue(stop)
    hookMocks.take.mockResolvedValueOnce(activation)
    hookMocks.revalidate.mockResolvedValue("allowed")

    const rendered = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await waitFor(() => expect(assign).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1",
    ))
    expect(hookMocks.revalidate).toHaveBeenCalledWith(activation.target)
    expect(hookMocks.dismiss).not.toHaveBeenCalled()

    rendered.unmount()
    expect(stop).toHaveBeenCalledOnce()

    hookMocks.take.mockResolvedValue(null)
    hookMocks.dismiss
      .mockRejectedValueOnce(new Error("native unavailable"))
      .mockResolvedValueOnce(undefined)
    vi.stubGlobal("location", {
      href: "https://alook.test/c/channels/server_1/channel_1",
      assign,
    })
    const destination = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await waitFor(() => expect(hookMocks.dismiss).toHaveBeenCalledOnce())
    expect(window.sessionStorage.length).toBe(1)
    await act(async () => { await Promise.resolve() })
    window.dispatchEvent(new Event("focus"))
    await waitFor(() => expect(hookMocks.dismiss).toHaveBeenCalledTimes(2))
    expect(hookMocks.dismiss).toHaveBeenLastCalledWith(activation.notificationId)
    await waitFor(() => expect(window.sessionStorage.length).toBe(0))
    destination.unmount()
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it("deduplicates concurrent destination mounts before native dismissal settles", async () => {
    const notificationId = activation.notificationId
    const dismissal = createNativeSystemNotificationDismissalQueue({
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
      now: () => Date.now(),
    })
    dismissal.queue("desktop", notificationId, "/c/channels/server_1/channel_1")
    vi.stubGlobal("location", {
      href: "https://alook.test/c/channels/server_1/channel_1",
      assign: vi.fn(),
    })
    hookMocks.listen.mockResolvedValue(vi.fn())
    hookMocks.take.mockResolvedValue(null)
    let resolveDismiss = () => undefined
    hookMocks.dismiss.mockImplementation(() => new Promise<void>((resolve) => {
      resolveDismiss = resolve
    }))

    const first = renderHook(() => useNativeSystemNotifications("viewer_1"))
    const second = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await waitFor(() => expect(hookMocks.dismiss).toHaveBeenCalledOnce())
    expect(window.sessionStorage.length).toBe(1)
    resolveDismiss()
    await waitFor(() => expect(window.sessionStorage.length).toBe(0))

    first.unmount()
    second.unmount()
  })

  it("persists an Inbox fallback, resumes it, and clears it after a real click", async () => {
    vi.useFakeTimers()
    const assign = vi.fn()
    const stop = vi.fn()
    vi.stubGlobal("location", { href: "https://alook.test/c/channels/server_1/channel_1", assign })
    hookMocks.listen.mockResolvedValue(stop)
    hookMocks.take.mockResolvedValueOnce(activation).mockResolvedValue(null)
    hookMocks.revalidate.mockResolvedValue("invalid")

    const first = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(assign).toHaveBeenCalledWith("https://alook.test/c")
    expect(hookMocks.retryActivation).not.toHaveBeenCalled()
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

  it("re-arms the exact desktop activation on retryable validation failure", async () => {
    const assign = vi.fn()
    const stop = vi.fn()
    const button = document.createElement("button")
    button.setAttribute("aria-label", "Inbox")
    const click = vi.spyOn(button, "click")
    document.body.append(button)
    vi.stubGlobal("location", { href: "https://alook.test/c/me/friends", assign })
    hookMocks.listen.mockResolvedValue(stop)
    hookMocks.take.mockResolvedValueOnce(activation).mockResolvedValue(null)
    hookMocks.revalidate.mockResolvedValue("retryable")

    const rendered = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await waitFor(() => expect(hookMocks.retryActivation).toHaveBeenCalledExactlyOnceWith(
      activation.notificationId,
    ))
    expect(click).toHaveBeenCalledOnce()
    expect(assign).not.toHaveBeenCalled()
    expect(hookMocks.dismiss).not.toHaveBeenCalled()

    rendered.unmount()
    expect(stop).toHaveBeenCalledOnce()
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
      .mockResolvedValueOnce({ href: "/c/me/channel_1" })
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
    expect(assign).toHaveBeenCalledWith("/c/me/channel_1")
    expect(hookMocks.mobileDismiss).not.toHaveBeenCalled()

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

  it("retries a mobile destination dismissal while the handoff is current", async () => {
    hookMocks.desktop = false
    hookMocks.mobile = true
    const notificationId = "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e"
    const dismissal = createNativeSystemNotificationDismissalQueue({
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
      now: () => Date.now(),
    })
    dismissal.queue("mobile", notificationId, "/c/me/channel_1")
    vi.stubGlobal("location", {
      href: "https://alook.test/c/me/channel_1",
      assign: vi.fn(),
    })
    hookMocks.mobileListen.mockResolvedValue(vi.fn())
    hookMocks.mobileCheck.mockResolvedValue("denied")
    hookMocks.mobileTake.mockResolvedValue(null)
    hookMocks.mobileDismiss
      .mockRejectedValueOnce(new Error("native unavailable"))
      .mockResolvedValueOnce(undefined)
    const visibilityState = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")

    const rendered = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await waitFor(() => expect(hookMocks.mobileDismiss).toHaveBeenCalledOnce())
    expect(window.sessionStorage.length).toBe(1)
    await act(async () => { await Promise.resolve() })
    document.dispatchEvent(new Event("visibilitychange"))
    await waitFor(() => expect(hookMocks.mobileDismiss).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(window.sessionStorage.length).toBe(0))

    rendered.unmount()
    visibilityState.mockRestore()
  })

  it.each(["unmounted", "open"])("preserves the page when a foreground activation read fails with Inbox %s", async (inboxState) => {
    vi.useFakeTimers()
    hookMocks.desktop = false
    hookMocks.mobile = true
    const assign = vi.fn()
    vi.stubGlobal("location", { href: "https://alook.test/c/channels/server_1/channel_1", assign })
    hookMocks.mobileListen.mockResolvedValue(vi.fn())
    hookMocks.mobileCheck.mockResolvedValue("denied")
    hookMocks.mobileTake.mockResolvedValueOnce(null).mockRejectedValue(new Error("native bridge unavailable"))
    const button = document.createElement("button")
    button.setAttribute("aria-label", "Close Inbox")
    const click = vi.spyOn(button, "click")
    if (inboxState === "open") document.body.append(button)
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    const rendered = renderHook(() => useNativeSystemNotifications("viewer_1"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await vi.advanceTimersByTimeAsync(2_100)
    })
    expect(hookMocks.mobileTake).toHaveBeenCalledTimes(2)
    expect(assign).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(window.sessionStorage.length).toBe(0)

    const nextActivation = {
      notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      messageId: "message_1",
      targetId: "channel_1",
    }
    hookMocks.mobileTake.mockResolvedValueOnce(nextActivation)
    hookMocks.mobileRevalidate.mockResolvedValueOnce({ href: "/c/me/channel_1" })
    await act(async () => {
      window.dispatchEvent(new Event("online"))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(assign).toHaveBeenCalledExactlyOnceWith("/c/me/channel_1")
    rendered.unmount()
    visible.mockRestore()
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
