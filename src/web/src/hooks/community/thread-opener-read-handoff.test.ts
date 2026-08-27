import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import type { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
import { useTimelineReadObserver } from "./use-read-observer"

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
const emptyScrollRoot = {
  querySelectorAll: () => [],
  contains: () => false,
} as unknown as HTMLElement

function DirectChildHarness() {
  useTimelineReadObserver({
    channelId: "child-1",
    messages: [],
    scrollRootEl: emptyScrollRoot,
    snapshotStatus: "error",
    feedStatus: "error",
    tailAttached: false,
    confirmedSeq: 0,
    catchUp: noCatchUp,
  })
  return null
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

async function render(lifecycle: Lifecycle = "pending") {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
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
    vi.clearAllMocks()
    mocks.submit.mockReturnValue(17)
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
      renderer.update(React.createElement(Harness, { lifecycle: "ready" }))
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
      renderer.update(React.createElement(
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
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Claim, { handoff: target }))
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
      renderer.update(React.createElement(Claim, { handoff: replacement }))
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
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Claim, { handoff: target }))
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
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Claim, { handoff: target }))
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
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Claim, { handoff: target }))
    })

    state.queryClient = client()
    await act(async () => {
      renderer.update(React.createElement(Claim, { handoff: target }))
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
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
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
      renderer.update(React.createElement(Harness, {
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
