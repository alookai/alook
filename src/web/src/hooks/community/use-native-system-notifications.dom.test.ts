import { describe, expect, it, vi } from "vitest"
import { waitFor } from "@/test/react-dom-harness"
import {
  createDesktopSystemNotificationActivationController,
  createDesktopSystemNotificationInboxOpener,
  type DesktopSystemNotificationInboxDeps,
} from "./use-native-system-notifications"
import type { DesktopSystemNotificationActivation } from "@/lib/community/system-notification-route"

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
})
