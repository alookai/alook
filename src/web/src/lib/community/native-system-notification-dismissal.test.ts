import { describe, expect, it, vi } from "vitest"
import {
  createNativeSystemNotificationDismissalQueue,
  type NativeSystemNotificationDismissalDeps,
} from "./native-system-notification-dismissal"

function deps(
  values: Map<string, string>,
  overrides: Partial<NativeSystemNotificationDismissalDeps> = {},
): NativeSystemNotificationDismissalDeps {
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => { values.delete(key) },
    now: () => 1_000,
    ...overrides,
  }
}

describe("native notification dismissal handoff", () => {
  const notificationId = "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e"

  it("completes an exact platform and destination match once", () => {
    const values = new Map<string, string>()
    const queue = createNativeSystemNotificationDismissalQueue(deps(values))
    expect(queue.queue("mobile", notificationId, "/c/me/channel_1")).toBe(true)
    expect(queue.peek("desktop", "/c/me/channel_1")).toBeNull()
    expect(queue.peek("mobile", "/c/me/channel_2")).toBeNull()
    expect(queue.peek("mobile", "/c/me/channel_1")).toBe(notificationId)
    expect(queue.complete("mobile", "/c/me/channel_2", notificationId)).toBe(false)
    expect(queue.complete("mobile", "/c/me/channel_1", notificationId)).toBe(true)
    expect(queue.peek("mobile", "/c/me/channel_1")).toBeNull()
  })

  it("rejects unsafe values and removes corrupt or expired handoffs", () => {
    const values = new Map<string, string>()
    const queue = createNativeSystemNotificationDismissalQueue(deps(values))
    expect(queue.queue("desktop", "bad", "/c/me/channel_1")).toBe(false)
    expect(queue.queue("desktop", notificationId, "https://evil.test/c/me/channel_1")).toBe(false)

    values.set("alook:native-system-notification:pending-dismissal", "corrupt")
    expect(queue.peek("desktop", "/c/me/channel_1")).toBeNull()
    expect(values.size).toBe(0)

    values.set("alook:native-system-notification:pending-dismissal", JSON.stringify({
      version: 1,
      platform: "desktop",
      notificationId,
      pathname: "/c/me/channel_1",
      expiresAt: 1_000,
    }))
    expect(queue.peek("desktop", "/c/me/channel_1")).toBeNull()
    expect(values.size).toBe(0)
  })

  it("keeps navigation best-effort when session storage is unavailable", () => {
    const queue = createNativeSystemNotificationDismissalQueue(deps(new Map(), {
      getItem: () => { throw new Error("blocked") },
      setItem: () => { throw new Error("blocked") },
      removeItem: vi.fn(),
    }))
    expect(queue.queue("mobile", notificationId, "/c/me/channel_1")).toBe(false)
    expect(queue.peek("mobile", "/c/me/channel_1")).toBeNull()
  })

  it("drops an invalid handoff even when storage removal is blocked", () => {
    const values = new Map([
      ["alook:native-system-notification:pending-dismissal", "corrupt"],
    ])
    const removeItem = vi.fn(() => { throw new Error("blocked") })
    const queue = createNativeSystemNotificationDismissalQueue(deps(values, { removeItem }))

    expect(queue.peek("mobile", "/c/me/channel_1")).toBeNull()
    expect(removeItem).toHaveBeenCalledOnce()
  })
})
