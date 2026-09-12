import React from "react"
import type { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render as rtlRender } from "@/test/react-dom-harness"

const state = vi.hoisted(() => ({
  queryClient: null as QueryClient | null,
  params: "inboxThreadOpener=nonce-1&msg=message-9&tab=all",
  pathname: "/c/channels/server-1/child-1",
}))
const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  register: vi.fn(() => ({ lease: "parent" })),
  release: vi.fn(),
  confirm: vi.fn(),
  resume: vi.fn(),
  submit: vi.fn(() => 17),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(state.params),
  usePathname: () => state.pathname,
}))
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return { ...actual, useQueryClient: () => state.queryClient }
})
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer" }),
}))
vi.mock("./read-coordinator", () => ({
  registerReadSurface: (...args: unknown[]) => mocks.register(...args),
  releaseReadSurface: (...args: unknown[]) => mocks.release(...args),
  confirmReadSurface: (...args: unknown[]) => mocks.confirm(...args),
  resumeReadCoordinator: (...args: unknown[]) => mocks.resume(...args),
  submitReadIntentGeneration: (...args: unknown[]) => mocks.submit(...args),
}))

import {
  armThreadOpenerReadHandoff,
  clearThreadOpenerReadHandoff,
  useClaimThreadOpenerReadHandoff,
  useThreadOpenerRouteGate,
} from "./thread-opener-read-handoff"
import {
  armThreadOpenerReservationHandoff,
  disposeInboxReadReservation,
  getThreadOpenerReservationHandoff,
  reserveInboxUnreadsResponse,
  type ThreadOpenerHandoffTarget,
} from "./inbox-read-reservation"
import { useTimelineReadObserver, type ReadCandidate } from "./use-read-observer"

type Lifecycle = "pending" | "ready" | "terminal-error"

const target: ThreadOpenerHandoffTarget = {
  nonce: "nonce-1",
  serverId: "server-1",
  parentChannelId: "parent-1",
  childChannelId: "child-1",
  openerMessageId: "opener-7",
  openerSeq: 7,
}

function client() {
  return {
    cancelQueries: vi.fn().mockResolvedValue(undefined),
    refetchQueries: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueryClient
}

function Claim({ handoff }: {
  handoff: ReturnType<typeof getThreadOpenerReservationHandoff> | undefined
}) {
  useClaimThreadOpenerReadHandoff(handoff)
  return null
}

function Harness({
  lifecycle,
  childChannelId = "child-1",
  parentChannelId = "parent-1",
  openerMessageId = "opener-7",
}: {
  lifecycle: Lifecycle
  childChannelId?: string
  parentChannelId?: string | null
  openerMessageId?: string | null
}) {
  const handoff = useThreadOpenerRouteGate({
    serverId: "server-1",
    childChannelId,
    parentChannelId,
    openerMessageId,
    lifecycle,
  })
  return React.createElement(Claim, { handoff: handoff ?? undefined })
}

const noCatchUp = () => Promise.resolve()
const defaultChildMessages: ReadCandidate[] = [
  { id: "message-4", seq: 4, authorId: "other-1", createdAt: "t4" },
]
type ReadObserverRecord = {
  callback: IntersectionObserverCallback
  observed: Set<Element>
  disconnected: boolean
}

let readObservers: ReadObserverRecord[] = []

class FakeReadIntersectionObserver {
  private readonly record: ReadObserverRecord

  constructor(callback: IntersectionObserverCallback) {
    this.record = { callback, observed: new Set(), disconnected: false }
    readObservers.push(this.record)
  }

  observe(element: Element) {
    this.record.observed.add(element)
  }

  unobserve(element: Element) {
    this.record.observed.delete(element)
  }

  takeRecords() {
    return []
  }

  disconnect() {
    this.record.disconnected = true
    this.record.observed.clear()
  }
}

function emitReadIntersection(record: ReadObserverRecord, target: Element) {
  record.callback([{
    target,
    isIntersecting: true,
    intersectionRatio: 1,
  } as IntersectionObserverEntry], {} as IntersectionObserver)
}

function DirectChildHarness({
  hidden = false,
  lifecycle = "error",
  messages = defaultChildMessages,
  catchUp = noCatchUp,
}: {
  hidden?: boolean
  lifecycle?: "ready" | "error"
  messages?: ReadCandidate[]
  catchUp?: () => Promise<unknown>
}) {
  const [scrollRootEl, setScrollRootEl] = React.useState<HTMLElement | null>(null)
  useTimelineReadObserver({
    channelId: "child-1",
    messages: lifecycle === "ready" ? messages : [],
    scrollRootEl,
    snapshotStatus: lifecycle,
    feedStatus: lifecycle,
    tailAttached: lifecycle === "ready",
    confirmedSeq: 0,
    catchUp,
  })
  return React.createElement(
    "div",
    { ref: setScrollRootEl },
    React.createElement(
      "div",
      {
        "data-message-list-content": "",
        "aria-hidden": hidden ? "true" : "false",
        inert: hidden ? true : undefined,
      },
      React.createElement("div", { "data-msg-id": messages[0]?.id ?? "message-4" }),
    ),
  )
}

function openerResponse() {
  return {
    servers: [{
      channels: [{
        channelId: "parent-1",
        lastMessageAt: "2026-08-27T01:00:00.000Z",
        children: [{
          channelId: "child-1",
          lastMessageAt: "2026-08-27T01:00:00.000Z",
          openerMessageId: "opener-7",
          openerSeq: 7,
          openerUnread: true,
        }],
      }],
    }],
    dms: [],
  }
}

function directResponse(lastMessageAt = "2026-08-27T01:00:00.000Z") {
  return {
    servers: [{
      channels: [{
        channelId: "child-1",
        lastMessageAt,
        hasDirectUnread: true,
        children: [],
      }],
    }],
    dms: [],
  }
}

async function render(lifecycle: Lifecycle = "pending") {
  let renderer!: ReturnType<typeof rtlRender>
  await act(async () => {
    renderer = rtlRender(
      React.createElement(React.StrictMode, null, React.createElement(Harness, { lifecycle })),
    )
  })
  return renderer
}

describe("thread opener read handoff", () => {
  beforeEach(() => {
    state.queryClient = client()
    state.params = "inboxThreadOpener=nonce-1&msg=message-9&tab=all"
    state.pathname = "/c/channels/server-1/child-1"
    readObservers = []
    vi.clearAllMocks()
    mocks.submit.mockReturnValue(17)
    vi.stubGlobal("IntersectionObserver", FakeReadIntersectionObserver)
  })

  afterEach(() => {
    if (state.queryClient) disposeInboxReadReservation(state.queryClient)
    vi.unstubAllGlobals()
  })

  it("arms an opaque generic nonce URL and clears it explicitly", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "nonce-fixed" })
    const href = armThreadOpenerReadHandoff(state.queryClient!, {
      serverId: "server-1",
      parentChannelId: "parent-1",
      childChannelId: "child-1",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    expect(href).toBe("/c/channels/server-1/child-1?inboxThreadOpener=nonce-fixed")
    expect(getThreadOpenerReservationHandoff(state.queryClient!, "nonce-fixed"))
      .toMatchObject({ parentChannelId: "parent-1", openerSeq: 7 })
    expect(clearThreadOpenerReadHandoff(state.queryClient!)).toBeUndefined()
    expect(getThreadOpenerReservationHandoff(state.queryClient!, "nonce-fixed")).toBeNull()
  })

  it("falls back to unique local nonces when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", undefined)
    const input = {
      serverId: "server-1",
      parentChannelId: "parent-1",
      childChannelId: "child-1",
      openerMessageId: "opener-7",
      openerSeq: 7,
    }
    const first = armThreadOpenerReadHandoff(state.queryClient!, input)
    const second = armThreadOpenerReadHandoff(state.queryClient!, input)
    expect(first).toMatch(/inboxThreadOpener=opener-\d+$/)
    expect(second).toMatch(/inboxThreadOpener=opener-\d+$/)
    expect(second).not.toBe(first)
  })

  it("cleans an aligned nonce URL when no matching handoff exists", async () => {
    const renderer = await render("ready")
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.replace).toHaveBeenCalledWith(
      "/c/channels/server-1/child-1?msg=message-9&tab=all",
      { scroll: false },
    )
    await act(async () => renderer.unmount())
  })

  it("keeps a nonce-free aligned route outside handoff ownership", async () => {
    state.params = "msg=message-9&tab=all"
    const renderer = await render("ready")
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(state.queryClient!.refetchQueries).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  it("survives a real pending-to-ready rerender, then claims the exact parent and preserves child msg", async () => {
    armThreadOpenerReservationHandoff(state.queryClient!, target)
    const renderer = await render("pending")
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(getThreadOpenerReservationHandoff(state.queryClient!, "nonce-1")).not.toBeNull()

    await act(async () => {
      renderer.rerender(React.createElement(Harness, { lifecycle: "ready" }))
    })

    expect(mocks.register).toHaveBeenCalledWith(
      state.queryClient,
      "viewer",
      { kind: "timeline", channelId: "parent-1" },
      0,
      "cancel-uncommitted",
    )
    expect(mocks.submit).toHaveBeenCalledWith({ lease: "parent" }, {
      kind: "timeline",
      channelId: "parent-1",
      messageId: "opener-7",
      seq: 7,
    })
    expect(state.queryClient!.refetchQueries).not.toHaveBeenCalled()
    expect(mocks.replace).toHaveBeenCalledWith(
      "/c/channels/server-1/child-1?msg=message-9&tab=all",
      { scroll: false },
    )
  })

  it("waits through a transient stale child render before classifying the aligned route", async () => {
    const nextTarget = { ...target, childChannelId: "child-2" }
    state.pathname = "/c/channels/server-1/child-2"
    armThreadOpenerReservationHandoff(state.queryClient!, nextTarget)
    const renderer = await render("pending")
    expect(getThreadOpenerReservationHandoff(state.queryClient!, "nonce-1")).not.toBeNull()
    expect(state.queryClient!.refetchQueries).not.toHaveBeenCalled()

    await act(async () => {
      renderer.rerender(React.createElement(
        React.StrictMode,
        null,
        React.createElement(Harness, { lifecycle: "ready", childChannelId: "child-2" }),
      ))
    })

    expect(mocks.submit).toHaveBeenCalledWith({ lease: "parent" }, {
      kind: "timeline",
      channelId: "parent-1",
      messageId: "opener-7",
      seq: 7,
    })
  })

  it("releases the prior parent lease before claiming a replacement target", async () => {
    armThreadOpenerReservationHandoff(state.queryClient!, target)
    let renderer!: ReturnType<typeof rtlRender>
    await act(async () => {
      renderer = rtlRender(React.createElement(Claim, { handoff: target }))
    })

    const replacement = {
      ...target,
      nonce: "nonce-2",
      openerMessageId: "opener-8",
      openerSeq: 8,
    }
    armThreadOpenerReservationHandoff(state.queryClient!, replacement)
    state.params = "inboxThreadOpener=nonce-2&msg=message-9&tab=all"
    await act(async () => {
      renderer.rerender(React.createElement(Claim, { handoff: replacement }))
    })

    expect(mocks.release).toHaveBeenCalledWith({ lease: "parent" })
    expect(mocks.submit).toHaveBeenLastCalledWith({ lease: "parent" }, {
      kind: "timeline",
      channelId: "parent-1",
      messageId: "opener-8",
      seq: 8,
    })
    await act(async () => renderer.unmount())
  })

  it("terminates a stale claim target without submitting its parent read", async () => {
    armThreadOpenerReservationHandoff(state.queryClient!, { ...target, openerSeq: 8 })
    let renderer!: ReturnType<typeof rtlRender>
    await act(async () => {
      renderer = rtlRender(React.createElement(Claim, { handoff: target }))
    })
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(getThreadOpenerReservationHandoff(state.queryClient!, "nonce-1")).toBeNull()
    await act(async () => renderer.unmount())
  })

  it("releases and terminates when the coordinator rejects the opener generation", async () => {
    mocks.submit.mockReturnValue(null)
    armThreadOpenerReservationHandoff(state.queryClient!, target)
    const renderer = await render("ready")
    expect(mocks.release).toHaveBeenCalledWith({ lease: "parent" })
    expect(getThreadOpenerReservationHandoff(state.queryClient!, "nonce-1")).toBeNull()
    await act(async () => renderer.unmount())
  })

  it("defers a claimed parent lease release until a true hook unmount", async () => {
    armThreadOpenerReservationHandoff(state.queryClient!, target)
    let renderer!: ReturnType<typeof rtlRender>
    await act(async () => {
      renderer = rtlRender(React.createElement(Claim, { handoff: target }))
    })
    expect(mocks.release).not.toHaveBeenCalled()
    await act(async () => {
      renderer.unmount()
      await Promise.resolve()
    })
    expect(mocks.release).toHaveBeenCalledWith({ lease: "parent" })
  })

  it("fences the deferred release when the hook lifetime is replaced before its microtask", async () => {
    const firstClient = state.queryClient!
    armThreadOpenerReservationHandoff(firstClient, target)
    let renderer!: ReturnType<typeof rtlRender>
    await act(async () => {
      renderer = rtlRender(React.createElement(Claim, { handoff: target }))
    })

    state.queryClient = client()
    await act(async () => {
      renderer.rerender(React.createElement(Claim, { handoff: target }))
      await Promise.resolve()
    })

    expect(mocks.release).not.toHaveBeenCalled()
    await act(async () => {
      renderer.unmount()
      await Promise.resolve()
    })
    expect(mocks.release).toHaveBeenCalledWith({ lease: "parent" })
    disposeInboxReadReservation(firstClient)
  })

  it("settles an orphaned push when a later nonce-free direct child route matches", async () => {
    armThreadOpenerReservationHandoff(state.queryClient!, target)
    state.params = "tab=all"
    let renderer!: ReturnType<typeof rtlRender>
    await act(async () => {
      renderer = rtlRender(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(DirectChildHarness),
        ),
      )
    })

    let pending!: Promise<ReturnType<typeof openerResponse>>
    await act(async () => {
      pending = reserveInboxUnreadsResponse(state.queryClient!, openerResponse())
      void pending.catch(() => undefined)
      await Promise.resolve()
    })

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(getThreadOpenerReservationHandoff(state.queryClient!, "nonce-1")).toBeNull()
    expect(state.queryClient!.refetchQueries).toHaveBeenCalledTimes(1)
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()

    vi.clearAllMocks()
    await act(async () => {
      renderer.rerender(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(DirectChildHarness, { hidden: true, lifecycle: "ready" }),
        ),
      )
      await Promise.resolve()
    })
    const readObserver = readObservers.findLast((record) => !record.disconnected)!
    const messageRow = renderer.container.querySelector<HTMLElement>("[data-msg-id='message-4']")!
    expect(readObserver.observed.has(messageRow)).toBe(true)

    emitReadIntersection(readObserver, messageRow)
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()

    await act(async () => {
      renderer.rerender(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(DirectChildHarness, { lifecycle: "ready" }),
        ),
      )
      await Promise.resolve()
    })
    expect(readObserver.observed.has(messageRow)).toBe(true)
    emitReadIntersection(readObserver, messageRow)
    expect(mocks.submit).toHaveBeenCalledOnce()
    expect(mocks.submit).toHaveBeenCalledWith({ lease: "parent" }, {
      kind: "timeline",
      channelId: "child-1",
      messageId: "message-4",
      seq: 4,
    })

    await act(async () => renderer.unmount())
  })

  it("reclassifies an authoritative absent candidate on reveal and releases its held response once", async () => {
    const messages: ReadCandidate[] = [{
      id: "message-10",
      seq: 10,
      authorId: "other-1",
      createdAt: "2026-08-27T02:00:00.000Z",
    }]
    const catchUp = vi.fn().mockResolvedValue(undefined)
    let renderer!: ReturnType<typeof rtlRender>
    await act(async () => {
      renderer = rtlRender(React.createElement(DirectChildHarness, {
        hidden: true,
        lifecycle: "ready",
        messages,
        catchUp,
      }))
    })

    let held!: Promise<ReturnType<typeof directResponse>>
    let settled = false
    await act(async () => {
      held = reserveInboxUnreadsResponse(state.queryClient!, directResponse())
      void held.then(() => { settled = true }, () => { settled = true })
      await Promise.resolve()
    })
    const readObserver = readObservers.findLast((record) => !record.disconnected)!
    const messageRow = renderer.container.querySelector<HTMLElement>("[data-msg-id='message-10']")!
    emitReadIntersection(readObserver, messageRow)

    expect(settled).toBe(false)
    expect(catchUp).not.toHaveBeenCalled()
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(state.queryClient!.refetchQueries).not.toHaveBeenCalled()

    await act(async () => {
      renderer.rerender(React.createElement(DirectChildHarness, {
        lifecycle: "ready",
        messages,
        catchUp,
      }))
      await Promise.resolve()
    })

    await expect(held).rejects.toMatchObject({ name: "AbortError" })
    expect(settled).toBe(true)
    expect(catchUp).not.toHaveBeenCalled()
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(state.queryClient!.refetchQueries).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
  })

  it("runs one behind-tail catch-up after reveal, then settles the still-absent held response", async () => {
    const messages: ReadCandidate[] = [{
      id: "message-1",
      seq: 1,
      authorId: "other-1",
      createdAt: "2026-08-27T00:00:00.000Z",
    }]
    let resolveCatchUp!: () => void
    const catchUp = vi.fn(() => new Promise<void>((resolve) => {
      resolveCatchUp = resolve
    }))
    let renderer!: ReturnType<typeof rtlRender>
    await act(async () => {
      renderer = rtlRender(React.createElement(DirectChildHarness, {
        hidden: true,
        lifecycle: "ready",
        messages,
        catchUp,
      }))
    })

    let held!: Promise<ReturnType<typeof directResponse>>
    let settled = false
    await act(async () => {
      held = reserveInboxUnreadsResponse(state.queryClient!, directResponse())
      void held.then(() => { settled = true }, () => { settled = true })
      await Promise.resolve()
    })
    const readObserver = readObservers.findLast((record) => !record.disconnected)!
    const messageRow = renderer.container.querySelector<HTMLElement>("[data-msg-id='message-1']")!
    emitReadIntersection(readObserver, messageRow)

    expect(settled).toBe(false)
    expect(catchUp).not.toHaveBeenCalled()
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()

    await act(async () => {
      renderer.rerender(React.createElement(DirectChildHarness, {
        lifecycle: "ready",
        messages,
        catchUp,
      }))
      await Promise.resolve()
    })

    expect(catchUp).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    expect(state.queryClient!.refetchQueries).not.toHaveBeenCalled()

    await act(async () => {
      resolveCatchUp()
      await catchUp.mock.results[0]!.value
      await Promise.resolve()
    })

    await expect(held).rejects.toMatchObject({ name: "AbortError" })
    expect(settled).toBe(true)
    expect(catchUp).toHaveBeenCalledOnce()
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(state.queryClient!.refetchQueries).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
  })

  it.each([
    ["terminal-error", null, null],
    ["ready", "parent-other", "opener-other"],
  ] as const)("takes one negative path for %s without consuming child msg", async (
    lifecycle,
    parentChannelId,
    openerMessageId,
  ) => {
    armThreadOpenerReservationHandoff(state.queryClient!, target)
    const renderer = await render("pending")
    await act(async () => {
      renderer.rerender(React.createElement(Harness, {
        lifecycle,
        parentChannelId,
        openerMessageId,
      }))
      await Promise.resolve()
    })

    expect(mocks.submit).not.toHaveBeenCalled()
    expect(state.queryClient!.refetchQueries).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledWith(
      "/c/channels/server-1/child-1?msg=message-9&tab=all",
      { scroll: false },
    )
  })

  it("terminates once after a true pending-route unmount", async () => {
    armThreadOpenerReservationHandoff(state.queryClient!, target)
    const renderer = await render("pending")
    await act(async () => {
      renderer.unmount()
      await Promise.resolve()
    })
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(state.queryClient!.refetchQueries).toHaveBeenCalledTimes(1)
  })
})
