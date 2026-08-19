import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useCommunityNavigationController } from "./use-community-navigation-controller"

const mocks = vi.hoisted(() => ({
  pathname: { current: "/c/me" },
  search: { current: new URLSearchParams() },
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
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
  onResult(useCommunityNavigationController())
  return null
}

async function renderController() {
  let current!: Result
  let renderer!: TestRenderer.ReactTestRenderer
  const onResult = (result: Result) => { current = result }
  await act(async () => {
    renderer = TestRenderer.create(createElement(Capture, { onResult }))
  })
  return {
    get current() { return current },
    rerender: async () => {
      await act(async () => renderer.update(createElement(Capture, { onResult })))
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
  })

  it("sets pending immediately and clears it after the committed href changes", async () => {
    const hook = await renderController()
    expect(hook.current.navigationPending).toBe(false)

    await act(async () => hook.current.push("/c/me/friends"))
    expect(mocks.push).toHaveBeenCalledWith("/c/me/friends")
    expect(hook.current.navigationPending).toBe(true)

    mocks.pathname.current = "/c/me/friends"
    await hook.rerender()
    expect(hook.current.navigationPending).toBe(false)
  })

  it("uses replace for semantic parent navigation", async () => {
    const hook = await renderController()
    await act(async () => hook.current.replace("/c/channels/s1"))
    expect(mocks.replace).toHaveBeenCalledWith("/c/channels/s1")
    expect(mocks.push).not.toHaveBeenCalled()
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
    resolveFirst("/c/channels/s1/c1")
    resolveSecond("/c/channels/s2/c2")

    await expect(firstResult).resolves.toBe(false)
    await expect(secondResult).resolves.toBe(true)
    expect(mocks.push).toHaveBeenCalledTimes(1)
    expect(mocks.push).toHaveBeenCalledWith("/c/channels/s2/c2")
  })
})
