import { describe, expect, it, vi } from "vitest"
import {
  createNativeSystemNotificationConversationDismissalQueue,
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
    expect(queue.queue("mobile", "viewer_1", notificationId, "/c/me/channel_1")).toBe(true)
    expect(queue.peek("desktop", "viewer_1", "/c/me/channel_1")).toBeNull()
    expect(queue.peek("mobile", "viewer_1", "/c/me/channel_2")).toBeNull()
    expect(queue.peek("mobile", "viewer_1", "/c/me/channel_1")).toBe(notificationId)
    expect(queue.complete("mobile", "viewer_1", "/c/me/channel_2", notificationId)).toBe(false)
    expect(queue.complete("mobile", "viewer_1", "/c/me/channel_1", notificationId)).toBe(true)
    expect(queue.peek("mobile", "viewer_1", "/c/me/channel_1")).toBeNull()
  })

  it("rejects unsafe values and removes corrupt or expired handoffs", () => {
    const values = new Map<string, string>()
    const queue = createNativeSystemNotificationDismissalQueue(deps(values))
    expect(queue.queue("desktop", "viewer_1", "bad", "/c/me/channel_1")).toBe(false)
    expect(queue.queue("desktop", "viewer_1", notificationId, "https://evil.test/c/me/channel_1")).toBe(false)

    values.set("alook:native-system-notification:pending-dismissal", "corrupt")
    expect(queue.peek("desktop", "viewer_1", "/c/me/channel_1")).toBeNull()
    expect(values.size).toBe(0)

    values.set("alook:native-system-notification:pending-dismissal", JSON.stringify({
      version: 1,
      platform: "desktop",
      notificationId,
      pathname: "/c/me/channel_1",
      expiresAt: 1_000,
    }))
    expect(queue.peek("desktop", "viewer_1", "/c/me/channel_1")).toBeNull()
    expect(values.size).toBe(0)
  })

  it("keeps navigation best-effort when session storage is unavailable", () => {
    const queue = createNativeSystemNotificationDismissalQueue(deps(new Map(), {
      getItem: () => { throw new Error("blocked") },
      setItem: () => { throw new Error("blocked") },
      removeItem: vi.fn(),
    }))
    expect(queue.queue("mobile", "viewer_1", notificationId, "/c/me/channel_1")).toBe(false)
    expect(queue.peek("mobile", "viewer_1", "/c/me/channel_1")).toBeNull()
  })

  it("drops an invalid handoff even when storage removal is blocked", () => {
    const values = new Map([
      ["alook:native-system-notification:pending-dismissal", "corrupt"],
    ])
    const removeItem = vi.fn(() => { throw new Error("blocked") })
    const queue = createNativeSystemNotificationDismissalQueue(deps(values, { removeItem }))

    expect(queue.peek("mobile", "viewer_1", "/c/me/channel_1")).toBeNull()
    expect(removeItem).toHaveBeenCalledOnce()
  })
})

describe("native notification conversation dismissal revisions", () => {
  const target = { kind: "server" as const, serverId: "server_1", channelId: "channel_1" }
  const key = "alook:native-system-notification:conversation-dismissals"
  it("keeps a newer demand when an older dismissal completes, including remove/recreate ABA", () => {
    const values = new Map<string, string>()
    const queue = createNativeSystemNotificationConversationDismissalQueue(deps(values))
    queue.queue("desktop", "viewer_1", target)
    const first = queue.pending("desktop", "viewer_1")[0]!
    queue.queue("desktop", "viewer_1", target)
    const second = queue.pending("desktop", "viewer_1")[0]!
    expect(second.revision).not.toBe(first.revision)
    expect(queue.complete("desktop", "viewer_1", target, first.revision)).toBe(false)
    expect(queue.complete("desktop", "viewer_2", target, second.revision)).toBe(false)
    expect(queue.complete("mobile", "viewer_1", target, second.revision)).toBe(false)
    expect(queue.complete("desktop", "viewer_1", target, second.revision)).toBe(true)
    queue.queue("desktop", "viewer_1", target)
    expect(queue.complete("desktop", "viewer_1", target, second.revision)).toBe(false)
    expect(queue.pending("desktop", "viewer_1")).toHaveLength(1)
  })
  it("migrates a legacy demand once in the same key and survives recreation", () => {
    const values = new Map([[key, JSON.stringify([{version:1, platform:"mobile", viewerUserId:"viewer_1", target}])]])
    const first = createNativeSystemNotificationConversationDismissalQueue(deps(values))
    const demand = first.pending("mobile", "viewer_1")[0]!
    expect(JSON.parse(values.get(key)!)[0].version).toBe(2)
    const restored = createNativeSystemNotificationConversationDismissalQueue(deps(values))
    expect(restored.pending("mobile", "viewer_1")).toEqual([demand])
    expect(restored.pending("desktop", "viewer_1")).toEqual([])
    expect(restored.complete("mobile", "viewer_1", target, demand.revision)).toBe(true)
    expect(values.size).toBe(0)
  })
  it("bounds scopes and rejects corrupt storage, unsafe identities, and failed writes", () => {
    const values = new Map<string, string>()
    const queue = createNativeSystemNotificationConversationDismissalQueue(deps(values))
    for (let i=0; i<65; i++) queue.queue("desktop", "viewer_1", { kind:"dm", channelId:`dm_${i}` })
    expect(queue.pending("desktop", "viewer_1")).toHaveLength(64)
    expect(queue.pending("desktop", "viewer_1")[0]!.target.channelId).toBe("dm_1")
    expect(queue.queue("desktop", "../viewer", target)).toBe(false)
    values.set(key, "broken")
    expect(queue.pending("desktop", "viewer_1")).toEqual([])
    expect(values.size).toBe(0)
    const blocked = createNativeSystemNotificationConversationDismissalQueue(deps(values,{setItem:()=>{throw new Error("blocked")}}))
    expect(blocked.queue("mobile", "viewer_1", target)).toBe(false)
  })
})
