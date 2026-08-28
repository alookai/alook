import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  InboxProjectionTerminalReceipt,
  InboxRowTarget,
} from "./inbox-read-reservation"
import { useInboxAutoCollapse } from "./use-inbox-auto-collapse"

const mocks = vi.hoisted(() => ({
  callbacks: new Map<symbol, (receipt: InboxProjectionTerminalReceipt) => void>(),
  activate: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock("./inbox-read-reservation", async (importOriginal) => {
  const original = await importOriginal<typeof import("./inbox-read-reservation")>()
  return {
    ...original,
    registerInboxProjectionTicket: (
      queryClient: unknown,
      epoch: number,
      _target: InboxRowTarget,
      callback: (receipt: InboxProjectionTerminalReceipt) => void,
    ) => {
      const token = Symbol(String(epoch))
      mocks.callbacks.set(token, callback)
      return { queryClient, epoch, token }
    },
    activateInboxProjectionTicket: (...args: unknown[]) => mocks.activate(...args),
    cancelInboxProjectionTicket: (...args: unknown[]) => mocks.cancel(...args),
  }
})

const target = (fingerprint = "g1", channelId = "c1"): InboxRowTarget => ({
  kind: "channel-direct",
  identity: JSON.stringify(["channel-direct", "s1", channelId]),
  fingerprint,
  confirmationChannelId: channelId,
  serverId: "s1",
  channelId,
})

type Options = Parameters<typeof useInboxAutoCollapse>[0]
type Api = ReturnType<typeof useInboxAutoCollapse>

function Capture({ options, onResult }: { options: Options; onResult: (api: Api) => void }) {
  onResult(useInboxAutoCollapse(options))
  return null
}

async function renderHook(overrides: Partial<Options> = {}) {
  let current!: Api
  let options = {
    queryClient: {} as Options["queryClient"],
    publishedHref: "/c/channels/s1",
    navigationPending: false,
    pendingHref: null,
    ...overrides,
  }
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Capture, {
      options,
      onResult: (api) => { current = api },
    }))
  })
  return {
    get current() { return current },
    async call(callback: () => void) {
      await act(async () => callback())
    },
    async rerender(next: Partial<Options>) {
      options = { ...options, ...next }
      await act(async () => {
        renderer.update(createElement(Capture, {
          options,
          onResult: (api) => { current = api },
        }))
      })
    },
    async unmount() {
      await act(async () => renderer.unmount())
    },
  }
}

describe("useInboxAutoCollapse", () => {
  beforeEach(() => {
    mocks.callbacks.clear()
    mocks.activate.mockReset()
    mocks.cancel.mockReset()
  })

  it("closes immediately and projects only the exact identity and fingerprint", async () => {
    const hook = await renderHook()
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.call(() => hook.current.beginProjection(target(), "/c/channels/s1/c1"))

    expect(hook.current.open).toBe(false)
    expect(hook.current.isProjected(target())).toBe(true)
    expect(hook.current.isProjected(target("g2"))).toBe(false)
    expect(hook.current.isProjected(target("g1", "c2"))).toBe(false)
  })

  it("preserves a tombstone across manual close and reopen", async () => {
    const hook = await renderHook()
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.call(() => hook.current.beginProjection(target(), "/c/channels/s1/c1"))
    await hook.call(() => hook.current.onOpenChange(true))
    expect(hook.current.isProjected(target())).toBe(true)
  })

  it("preserves the latest lease across a shell controller remount", async () => {
    const queryClient = {} as Options["queryClient"]
    const href = "/c/channels/s1/c1"
    const first = await renderHook({
      queryClient,
      navigationPending: true,
      pendingHref: href,
    })
    let epoch = 0
    await first.call(() => { epoch = first.current.beginProjection(target(), href) })
    await first.call(() => first.current.markProjectionSubmitted(epoch))
    await first.unmount()

    const second = await renderHook({ queryClient, publishedHref: href })
    expect(second.current.isProjected(target())).toBe(true)
  })

  it("activates a same-href ticket immediately after submission", async () => {
    const hook = await renderHook({ publishedHref: "/c/channels/s1/c1" })
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), "/c/channels/s1/c1") })
    await hook.call(() => hook.current.markProjectionSubmitted(epoch))
    expect(mocks.activate).toHaveBeenCalledTimes(1)
  })

  it("activates only after a pending destination publishes", async () => {
    const href = "/c/channels/s1/c1"
    const hook = await renderHook()
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), href) })
    await hook.rerender({ navigationPending: true, pendingHref: href })
    await hook.call(() => hook.current.markProjectionSubmitted(epoch))
    expect(mocks.activate).not.toHaveBeenCalled()
    await hook.rerender({ publishedHref: href, navigationPending: false, pendingHref: null })
    expect(mocks.activate).toHaveBeenCalledTimes(1)
  })

  it("rolls back a canceled pre-commit intent without reopening", async () => {
    const href = "/c/channels/s1/c1"
    const hook = await renderHook({ navigationPending: true, pendingHref: href })
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), href) })
    await hook.call(() => hook.current.markProjectionSubmitted(epoch))
    await hook.rerender({ navigationPending: false, pendingHref: null })
    expect(hook.current.isProjected(target())).toBe(false)
    expect(hook.current.open).toBe(false)
  })

  it("restores the prior open state for a latest synchronous push failure", async () => {
    const hook = await renderHook()
    await hook.call(() => hook.current.onOpenChange(true))
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), "/c/channels/s1/c1") })
    await hook.call(() => hook.current.rollbackProjection(epoch, true))
    expect(hook.current.open).toBe(true)
    expect(hook.current.isProjected(target())).toBe(false)
  })

  it("ignores a stale receipt after A is superseded by B", async () => {
    const hook = await renderHook()
    let aEpoch = 0
    await hook.call(() => { aEpoch = hook.current.beginProjection(target(), "/c/channels/s1/c1") })
    const aCallback = [...mocks.callbacks.values()][0]!
    await hook.call(() => hook.current.beginProjection(target("b1", "c2"), "/c/channels/s1/c2"))
    await hook.call(() => aCallback({
      epoch: aEpoch,
      target: target(),
      terminal: "success",
      disposition: "retire",
      observedFingerprint: null,
    }))
    expect(hook.current.isProjected(target("b1", "c2"))).toBe(true)
  })

  it("clears the matching projection for either frozen terminal disposition", async () => {
    const hook = await renderHook({ publishedHref: "/c/channels/s1/c1" })
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), "/c/channels/s1/c1") })
    const callback = [...mocks.callbacks.values()][0]!
    await hook.call(() => hook.current.markProjectionSubmitted(epoch))
    await hook.call(() => callback({
      epoch,
      target: target(),
      terminal: "negative",
      disposition: "rollback",
      observedFingerprint: "g1",
    }))
    expect(hook.current.isProjected(target())).toBe(false)
  })
})
