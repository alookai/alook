

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import type {
  InboxProjectionTerminalReceipt,
  InboxRowTarget,
} from "./inbox-read-reservation"
import {
  useInboxAutoCollapse,
} from "./use-inbox-auto-collapse"

const mocks = vi.hoisted(() => ({
  callbacks: new Map<symbol, (receipt: InboxProjectionTerminalReceipt) => void>(),
  register: vi.fn(),
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
      mocks.register(queryClient, epoch, _target)
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

function renderInboxHook(overrides: Partial<Options> = {}) {
  let options: Options = {
    queryClient: {} as Options["queryClient"],
    publishedHref: "/c/channels/s1",
    navigationPending: false,
    pendingHref: null,
    ...overrides,
  }
  const rendered = renderHook(
    ({ currentOptions }: { currentOptions: Options }) => useInboxAutoCollapse(currentOptions),
    { initialProps: { currentOptions: options } },
  )
  return {
    get current() { return rendered.result.current },
    async call(callback: () => void) {
      await act(async () => callback())
    },
    async rerender(next: Partial<Options>) {
      options = { ...options, ...next }
      rendered.rerender({ currentOptions: options })
    },
    async unmount() {
      rendered.unmount()
    },
  }
}

describe("useInboxAutoCollapse", () => {
  beforeEach(() => {
    mocks.callbacks.clear()
    mocks.register.mockReset()
    mocks.activate.mockReset()
    mocks.cancel.mockReset()
  })

  it("closes immediately and projects only the exact identity and fingerprint", async () => {
    const hook = renderInboxHook()
    await hook.call(() => hook.current.onOpenChange(true))
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), "/c/channels/s1/c1") })

    expect(hook.current.open).toBe(false)
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith(expect.anything(), epoch, target())
    expect(hook.current.isLatestProjection(epoch)).toBe(true)
  })

  it("preserves a tombstone across manual close and reopen", async () => {
    const hook = renderInboxHook()
    await hook.call(() => hook.current.onOpenChange(true))
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), "/c/channels/s1/c1") })
    await hook.call(() => hook.current.onOpenChange(true))
    expect(hook.current.isLatestProjection(epoch)).toBe(true)
  })

  it("closes an open Inbox when an unrelated destination publishes", async () => {
    const hook = renderInboxHook()
    await hook.call(() => hook.current.onOpenChange(true))
    expect(hook.current.open).toBe(true)

    await hook.rerender({ publishedHref: "/c/me" })

    expect(hook.current.open).toBe(false)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it("keeps a reopened Inbox visible when the consumed opener handoff leaves the same route", async () => {
    const href = "/c/channels/s1/c1"
    const hook = renderInboxHook({ publishedHref: `${href}?inboxThreadOpener=first&keep=1` })
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.rerender({ publishedHref: `${href}?keep=1` })
    expect(hook.current.open).toBe(true)
    await hook.rerender({ publishedHref: `${href}?keep=2` })
    expect(hook.current.open).toBe(false)
  })

  it("preserves the latest lease across a shell controller remount", async () => {
    const queryClient = {} as Options["queryClient"]
    const href = "/c/channels/s1/c1"
    const first = renderInboxHook({
      queryClient,
      navigationPending: true,
      pendingHref: href,
    })
    let epoch = 0
    await first.call(() => { epoch = first.current.beginProjection(target(), href) })
    await first.call(() => first.current.markProjectionSubmitted(epoch))
    await first.unmount()

    const second = renderInboxHook({ queryClient, publishedHref: href })
    expect(second.current.isLatestProjection(epoch)).toBe(true)
  })

  it("activates a same-href ticket immediately after submission", async () => {
    const hook = renderInboxHook({ publishedHref: "/c/channels/s1/c1" })
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), "/c/channels/s1/c1") })
    await hook.call(() => hook.current.markProjectionSubmitted(epoch))
    expect(mocks.activate).toHaveBeenCalledTimes(1)
  })

  it("activates only after a pending destination publishes", async () => {
    const href = "/c/channels/s1/c1"
    const hook = renderInboxHook()
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), href) })
    await hook.rerender({ navigationPending: true, pendingHref: href })
    await hook.call(() => hook.current.markProjectionSubmitted(epoch))
    expect(mocks.activate).not.toHaveBeenCalled()
    await hook.rerender({ publishedHref: href, navigationPending: false, pendingHref: null })
    expect(mocks.activate).toHaveBeenCalledTimes(1)
  })

  it("keeps the projection through the submitted-to-pending router gap", async () => {
    const href = "/c/channels/s1/c1"
    const hook = renderInboxHook()
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), href) })
    await hook.call(() => hook.current.markProjectionSubmitted(epoch))

    expect(hook.current.isLatestProjection(epoch)).toBe(true)
    expect(mocks.cancel).not.toHaveBeenCalled()

    await hook.rerender({ navigationPending: true, pendingHref: href })
    await hook.rerender({ publishedHref: href, navigationPending: false, pendingHref: null })
    expect(mocks.activate).toHaveBeenCalledTimes(1)
  })

  it("rolls back a canceled pre-commit intent without reopening", async () => {
    const href = "/c/channels/s1/c1"
    const hook = renderInboxHook({ navigationPending: true, pendingHref: href })
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), href) })
    await hook.call(() => hook.current.markProjectionSubmitted(epoch))
    await hook.rerender({ navigationPending: false, pendingHref: null })
    expect(hook.current.isLatestProjection(epoch)).toBe(false)
    expect(hook.current.open).toBe(false)
  })

  it("restores the prior open state for a latest synchronous push failure", async () => {
    const hook = renderInboxHook()
    await hook.call(() => hook.current.onOpenChange(true))
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), "/c/channels/s1/c1") })
    await hook.call(() => hook.current.rollbackProjection(epoch, true))
    expect(hook.current.open).toBe(true)
    expect(hook.current.isLatestProjection(epoch)).toBe(false)
  })

  it("ignores a stale receipt after A is superseded by B", async () => {
    const hook = renderInboxHook()
    let aEpoch = 0
    await hook.call(() => { aEpoch = hook.current.beginProjection(target(), "/c/channels/s1/c1") })
    const aCallback = [...mocks.callbacks.values()][0]!
    let bEpoch = 0
    await hook.call(() => { bEpoch = hook.current.beginProjection(target("b1", "c2"), "/c/channels/s1/c2") })
    await hook.call(() => aCallback({
      epoch: aEpoch,
      target: target(),
      terminal: "success",
      disposition: "retire",
      observedFingerprint: null,
    }))
    expect(hook.current.isLatestProjection(bEpoch)).toBe(true)
    expect(hook.current.isLatestProjection(aEpoch)).toBe(false)
    expect(mocks.register).toHaveBeenLastCalledWith(expect.anything(), bEpoch, target("b1", "c2"))
  })

  it.each(["retire", "rollback"] as const)("clears the matching projection for terminal %s", async disposition => {
    const hook = renderInboxHook({ publishedHref: "/c/channels/s1/c1" })
    let epoch = 0
    await hook.call(() => { epoch = hook.current.beginProjection(target(), "/c/channels/s1/c1") })
    const callback = [...mocks.callbacks.values()][0]!
    await hook.call(() => hook.current.markProjectionSubmitted(epoch))
    await hook.call(() => callback({
      epoch,
      target: target(),
      terminal: "negative",
      disposition,
      observedFingerprint: disposition === "rollback" ? "g1" : null,
    }))
    expect(hook.current.isLatestProjection(epoch)).toBe(false)
  })
})
