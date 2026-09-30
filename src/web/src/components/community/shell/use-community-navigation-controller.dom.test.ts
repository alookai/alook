import { createElement } from "react"
import { act, render as rtlRender } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useCommunityNavigationController } from "./use-community-navigation-controller"
import { normalizeCommunityHref, type CommunityCommittedFrame } from "@/lib/community/community-route"

const mocks = vi.hoisted(() => ({
  pathname: { current: "/c/me" },
  search: { current: new URLSearchParams() },
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
  cancelProof: vi.fn(),
  queryClient: {},
  frame: {
    current: null as CommunityCommittedFrame | null,
  },
}))

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.queryClient,
}))
vi.mock("@/lib/community/conversation-navigation-proof", () => ({
  cancelActiveConversationNavigationProof: (...args: unknown[]) => mocks.cancelProof(...args),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname.current,
  useSearchParams: () => mocks.search.current,
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
    prefetch: mocks.prefetch,
  }),
}))
type Result = ReturnType<typeof useCommunityNavigationController>

function Capture({ onResult }: { onResult: (result: Result) => void }) {
  const result = useCommunityNavigationController(mocks.frame.current!)
  onResult(result)
  return createElement("output", {
    "data-navigation-pending": String(result.navigationPending),
    "data-pending-leaf": result.pendingHref ? normalizeCommunityHref(result.pendingHref).leafKey : "",
    "data-committed-leaf": mocks.frame.current!.leafKey,
  }, result.pendingHref)
}

async function renderController() {
  let current!: Result
  let renderer!: ReturnType<typeof rtlRender>
  const onResult = (result: Result) => { current = result }
  await act(async () => {
    renderer = rtlRender(createElement(Capture, { onResult }))
  })
  return {
    get current() { return current },
    get container() { return renderer.container },
    rerender: async () => {
      await act(async () => renderer.rerender(createElement(Capture, { onResult })))
    },
    unmount: async () => {
      await act(async () => renderer.unmount())
    },
  }
}

describe("useCommunityNavigationController", () => {
  beforeEach(() => {
    mocks.pathname.current = "/c/me"
    mocks.search.current = new URLSearchParams()
    mocks.push.mockReset()
    mocks.replace.mockReset()
    mocks.prefetch.mockReset()
    mocks.cancelProof.mockReset()
    mocks.frame.current = { ...normalizeCommunityHref("/c/me"), revision: 0 }
    const windowTarget = new EventTarget() as EventTarget & { navigation: EventTarget }
    windowTarget.navigation = new EventTarget()
    vi.stubGlobal("window", windowTarget)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("commits the target checkpoint to DOM inside router.push before the frame changes", async () => {
    const source = "/c/channels/s1/a"
    const target = "/c/channels/s1/b"
    mocks.pathname.current = source
    mocks.frame.current = { ...normalizeCommunityHref(source), revision: 7 }
    const hook = await renderController()
    const output = () => hook.container.querySelector("output")!
    expect(output().getAttribute("data-navigation-pending")).toBe("false")
    expect(output().getAttribute("data-pending-leaf")).toBe("")

    mocks.push.mockImplementation((href: string) => {
      expect(href).toBe(target)
      expect(output().getAttribute("data-navigation-pending")).toBe("true")
      expect(output().getAttribute("data-pending-leaf")).toBe(normalizeCommunityHref(target).leafKey)
      expect(output().getAttribute("data-committed-leaf")).toBe(normalizeCommunityHref(source).leafKey)
      expect(output().textContent).toBe(target)
      expect(hook.current.pendingHref).toBe(target)
    })
    await act(async () => hook.current.push(target))
    expect(mocks.push).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: "unchanged target revision", href: "/c/channels/s1/b", revision: 7 },
    { label: "older target revision", href: "/c/channels/s1/b", revision: 6 },
    { label: "newer wrong leaf", href: "/c/channels/s1/c", revision: 8 },
  ])("rejects $label and settles only a new matching frame, without transport completion", async ({ href, revision }) => {
    const source = "/c/channels/s1/a"
    const target = "/c/channels/s1/b"
    mocks.pathname.current = source
    mocks.frame.current = { ...normalizeCommunityHref(source), revision: 7 }
    let release!: () => void
    let transportFinished = false
    const transport = new Promise<void>((resolve) => { release = resolve })
    mocks.push.mockImplementation(() => { void transport.then(() => { transportFinished = true }) })
    const hook = await renderController()
    try {
      await act(async () => hook.current.push(target))
      await hook.rerender()
      expect(hook.current.navigationPending).toBe(true)
      expect(hook.current.pendingHref).toBe(target)
      mocks.pathname.current = target
      await hook.rerender()
      expect(hook.current.navigationPending).toBe(true)
      expect(hook.current.pendingHref).toBe(target)

      mocks.frame.current = { ...normalizeCommunityHref(href), revision }
      await hook.rerender()
      expect(hook.current.navigationPending).toBe(true)
      expect(hook.current.pendingHref).toBe(target)
      expect(hook.container.querySelector("output")!.textContent).toBe(target)

      mocks.frame.current = { ...normalizeCommunityHref(target), revision: 8 }
      await hook.rerender()
      expect(hook.current.navigationPending).toBe(false)
      expect(hook.current.pendingHref).toBeNull()
      expect(hook.container.querySelector("output")!.getAttribute("data-navigation-pending")).toBe("false")
      expect(hook.container.querySelector("output")!.textContent).toBe("")
      expect(transportFinished).toBe(false)
    } finally {
      release()
      await transport
    }
  })

  it("does not treat published pathname as commit and clears after frame evidence", async () => {
    const hook = await renderController()
    expect(hook.current.navigationPending).toBe(false)
    expect(hook.current.pendingHref).toBeNull()

    await act(async () => hook.current.push("/c/me/friends"))
    expect(mocks.push).toHaveBeenCalledWith("/c/me/friends")
    expect(hook.current.navigationPending).toBe(true)
    expect(hook.current.pendingHref).toBe("/c/me/friends")
    expect(mocks.cancelProof).toHaveBeenCalledWith(mocks.queryClient)

    mocks.pathname.current = "/c/me/friends"
    await hook.rerender()
    expect(hook.current.navigationPending).toBe(true)
    expect(hook.current.pendingHref).toBe("/c/me/friends")

    mocks.frame.current = { ...normalizeCommunityHref("/c/me/friends"), revision: 1 }
    await hook.rerender()
    expect(hook.current.navigationPending).toBe(false)
    expect(hook.current.pendingHref).toBeNull()
  })

  it("keeps only rapid B pending when stale A commits before B", async () => {
    const hook = await renderController()
    await act(async () => {
      hook.current.push("/c/channels/s1")
      hook.current.push("/c/channels/s2")
    })
    expect(mocks.push.mock.calls.map(([href]) => href)).toEqual([
      "/c/channels/s1",
      "/c/channels/s2",
    ])
    expect(hook.current.pendingHref).toBe("/c/channels/s2")

    mocks.pathname.current = "/c/channels/s1"
    mocks.frame.current = { ...normalizeCommunityHref("/c/channels/s1"), revision: 1 }
    await hook.rerender()
    expect(hook.current.navigationPending).toBe(true)
    expect(hook.current.pendingHref).toBe("/c/channels/s2")

    mocks.pathname.current = "/c/channels/s2/c2"
    mocks.frame.current = { ...normalizeCommunityHref("/c/channels/s2"), revision: 2 }
    await hook.rerender()
    expect(hook.current.navigationPending).toBe(false)
    expect(hook.current.pendingHref).toBeNull()
  })

  it("uses replace for semantic parent navigation", async () => {
    const hook = await renderController()
    await act(async () => hook.current.replace("/c/channels/s1"))
    expect(mocks.replace).toHaveBeenCalledWith("/c/channels/s1")
    expect(mocks.push).not.toHaveBeenCalled()
    expect(hook.current.pendingHref).toBe("/c/channels/s1")
    expect(mocks.cancelProof).toHaveBeenCalledWith(mocks.queryClient)
  })

  it("keeps a same-server root intent pending until the exact root frame commits", async () => {
    mocks.pathname.current = "/c/channels/s1/c1"
    mocks.frame.current = { ...normalizeCommunityHref("/c/channels/s1/c1"), revision: 6 }
    const hook = await renderController()

    await act(async () => hook.current.replace("/c/channels/s1"))
    mocks.pathname.current = "/c/channels/s1"
    await hook.rerender()
    expect(hook.current.pendingHref).toBe("/c/channels/s1")

    mocks.frame.current = { ...normalizeCommunityHref("/c/channels/s1/c1"), revision: 7 }
    await hook.rerender()
    expect(hook.current.pendingHref).toBe("/c/channels/s1")

    mocks.frame.current = { ...normalizeCommunityHref("/c/channels/s1"), revision: 8 }
    await hook.rerender()
    expect(hook.current.pendingHref).toBeNull()
  })

  it("settles same-leaf query and hash targets without a structural frame revision", async () => {
    mocks.pathname.current = "/c/me/friends"
    mocks.frame.current = { ...normalizeCommunityHref("/c/me/friends"), revision: 3 }
    const hook = await renderController()

    await act(async () => hook.current.push("/c/me/friends?b=2&a=1#card"))
    mocks.search.current = new URLSearchParams("a=1&b=2")
    await hook.rerender()
    expect(hook.current.pendingHref).toBeNull()
  })

  it("cancels pending on popstate without synthesizing router history", async () => {
    const hook = await renderController()
    await act(async () => hook.current.push("/c/me/friends"))
    await act(async () => window.dispatchEvent(new Event("popstate")))
    expect(hook.current.pendingHref).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledTimes(1)
    expect(mocks.cancelProof).toHaveBeenCalledTimes(2)
    await hook.unmount()
  })

  it("commits only the latest async destination", async () => {
    const hook = await renderController()
    let resolveFirst!: (href: string) => void
    let resolveSecond!: (href: string) => void
    const first = new Promise<string>((resolve) => { resolveFirst = resolve })
    const second = new Promise<string>((resolve) => { resolveSecond = resolve })
    let firstResult!: Promise<boolean>
    let secondResult!: Promise<boolean>

    await act(async () => {
      firstResult = hook.current.resolveAndPush(() => first)
      secondResult = hook.current.resolveAndPush(() => second)
    })
    await act(async () => {
      resolveFirst("/c/channels/s1/c1")
      resolveSecond("/c/channels/s2/c2")
      await expect(firstResult).resolves.toBe(false)
      await expect(secondResult).resolves.toBe(true)
    })
    expect(mocks.push).toHaveBeenCalledTimes(1)
    expect(mocks.push).toHaveBeenCalledWith("/c/channels/s2/c2")
    expect(hook.current.pendingHref).toBe("/c/channels/s2/c2")
    expect(mocks.cancelProof).toHaveBeenCalledTimes(2)
  })

  it("settles an async resolver that returns the published destination", async () => {
    const hook = await renderController()
    await expect(act(async () => (
      hook.current.resolveAndPush(async () => "/c/me")
    ))).resolves.toBe(true)
    expect(hook.current.navigationPending).toBe(false)
    expect(hook.current.pendingHref).toBeNull()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("clears pending destination state on cancellation and async failure", async () => {
    const hook = await renderController()
    await act(async () => hook.current.push("/c/me/friends"))
    expect(hook.current.pendingHref).toBe("/c/me/friends")

    await act(async () => hook.current.cancelPendingNavigation())
    expect(hook.current.navigationPending).toBe(false)
    expect(hook.current.pendingHref).toBeNull()

    await expect(act(async () => {
      await hook.current.resolveAndPush(async () => {
        throw new Error("lookup failed")
      })
    })).rejects.toThrow("lookup failed")
    expect(hook.current.navigationPending).toBe(false)
    expect(hook.current.pendingHref).toBeNull()
  })

  it("does not enter pending state for the committed href", async () => {
    const hook = await renderController()
    await act(async () => hook.current.push("/c/me"))
    expect(mocks.push).not.toHaveBeenCalled()
    expect(hook.current.navigationPending).toBe(false)
    expect(hook.current.pendingHref).toBeNull()
    expect(mocks.cancelProof).not.toHaveBeenCalled()
  })

  it("preserves the proof begun by an Inbox child handler", async () => {
    const hook = await renderController()
    await act(async () => hook.current.pushImmediate("/c/channels/s1/c1"))
    expect(mocks.push).toHaveBeenCalledWith("/c/channels/s1/c1")
    expect(mocks.cancelProof).not.toHaveBeenCalled()
  })
})
