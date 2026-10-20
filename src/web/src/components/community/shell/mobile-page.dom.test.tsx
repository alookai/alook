import { useMemo, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, screen, waitFor } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { CommunityRouteContext, type CommunityNavigationController } from "@/contexts/community/route-frame"
import { MobilePageBackContext, type MobilePageBack } from "@/contexts/community/mobile-page-back"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { requestNativeBack } from "@/components/ui/native-back-layer"
import { MobilePage } from "./mobile-page"
import { useCommunityRuntime } from "@/stores/community/runtime"

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }))
afterEach(() => vi.restoreAllMocks())

function fixture() {
  let current = true
  let narrow = true
  let breakpoint: "mobile" | "desktop" = "mobile"
  let runtime!: ReturnType<typeof useCommunityRuntime>
  vi.spyOn(window, "matchMedia").mockImplementation(media => ({
    media, matches: media === "(max-width: 639px)" && narrow, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }))
  let request: MobilePageBack | null = null
  const replace = vi.fn()
  const navigation: CommunityNavigationController = {
    publishedHref: "/c/me/friends", navigationPending: false, pendingHref: null,
    captureIntent: () => () => current, replace, push: vi.fn(), pushImmediate: vi.fn(),
    resolveAndPush: vi.fn(async () => true), cancelPendingNavigation: vi.fn(),
  }
  const frame = { ...normalizeCommunityHref(navigation.publishedHref), revision: 0 }
  function Fixture({ active = true, children = <input aria-label="Page draft" /> }: { active?: boolean; children?: ReactNode }) {
    runtime = useCommunityRuntime()
    const registry = useMemo(() => ({ register: (next: MobilePageBack) => {
      request = next
      return () => { if (request === next) request = null }
    } }), [])
    return <CommunityRouteContext value={{ breakpoint, navigation, frame, ownerDeleteRouteScope: undefined }}>
      <MobilePageBackContext value={registry}>
        <MobilePage active={active} parentPath="/c/me">{children}</MobilePage>
      </MobilePageBackContext>
    </CommunityRouteContext>
  }
  return { Fixture, replace, navigation, invalidate: () => { current = false }, back: () => request?.("/c/me"),
    widen: () => { narrow = false }, retire: () => runtime.lifecycle.setState(state => ({ ...state, active: false })),
    desktop: () => { narrow = false; breakpoint = "desktop" },
  }
}

function holdExit(popup: HTMLElement) {
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const animations = vi.fn(() => [{ finished, effect: { getTiming: () => ({ duration: 220, iterations: 1 }) } }])
  Object.defineProperty(popup, "getAnimations", { configurable: true, value: animations })
  return { finish, animations }
}

describe("mobile page dismissal", () => {
  it("reopens the retained current page on desktop while a completed mobile Back still waits for parent publication", async () => {
    const task = fixture()
    const view = render(<task.Fixture />)
    const input = screen.getByLabelText("Page draft")
    const popup = input.closest<HTMLElement>('[data-slot="mobile-page"]')!
    const animation = holdExit(popup)
    act(() => { task.back() })
    await waitFor(() => expect(animation.animations).toHaveBeenCalled())
    await act(async () => animation.finish())
    expect(task.replace).toHaveBeenCalledExactlyOnceWith("/c/me", { resume: true })
    task.navigation.pendingHref = "/c/me"
    view.rerender(<task.Fixture />)
    expect(popup).toHaveAttribute("data-closed")
    task.desktop()
    view.rerender(<task.Fixture />)
    expect(screen.getByLabelText("Page draft")).toBe(input)
    expect(popup).toHaveAttribute("data-open")
    expect(input.closest("[inert]")).toBeNull()
    expect(task.replace).toHaveBeenCalledTimes(1)
  })

  it.each(["viewport", "owner"])("checks live %s authority before a queued completion", async (boundary) => {
    const task = fixture()
    render(<task.Fixture />)
    const popup = screen.getByLabelText("Page draft").closest<HTMLElement>('[data-slot="mobile-page"]')!
    const animation = holdExit(popup)
    act(() => { task.back() })
    await waitFor(() => expect(animation.animations).toHaveBeenCalled())
    if (boundary === "viewport") task.widen()
    else task.retire()
    await act(async () => animation.finish())
    expect(task.replace).not.toHaveBeenCalled()
  })

  it("accepts close first and commits exactly one Back after the real completion boundary", async () => {
    const task = fixture()
    render(<task.Fixture />)
    const popup = screen.getByLabelText("Page draft").closest<HTMLElement>('[data-slot="mobile-page"]')!
    await waitFor(() => expect(popup).toHaveAttribute("data-open"))
    const animation = holdExit(popup)
    act(() => { expect(task.back()).toBe(true); expect(task.back()).toBe(true) })
    expect(popup).toHaveAttribute("data-closed")
    expect(task.replace).not.toHaveBeenCalled()
    await waitFor(() => expect(animation.animations).toHaveBeenCalled())
    await act(async () => animation.finish())
    await waitFor(() => expect(task.replace).toHaveBeenCalledExactlyOnceWith("/c/me", { resume: true }))
  })

  it("retires a closing callback when a newer navigation supersedes it", async () => {
    const task = fixture()
    const view = render(<task.Fixture />)
    const popup = screen.getByLabelText("Page draft").closest<HTMLElement>('[data-slot="mobile-page"]')!
    const animation = holdExit(popup)
    act(() => { task.back() })
    await waitFor(() => expect(animation.animations).toHaveBeenCalled())
    task.invalidate()
    task.navigation.publishedHref = "/c/me/bots"
    view.rerender(<task.Fixture />)
    await act(async () => animation.finish())
    expect(task.replace).not.toHaveBeenCalled()
    expect(popup).toHaveAttribute("data-open")
  })

  it("keeps page semantics and gives inactive background neither Back nor focus ownership", async () => {
    const task = fixture()
    const view = render(<task.Fixture />)
    const input = screen.getByLabelText("Page draft")
    const popup = input.closest('[data-slot="mobile-page"]')!
    expect(popup).toHaveAttribute("role", "presentation")
    expect(input).not.toHaveFocus()
    expect(requestNativeBack(document)).toBe("none")
    view.rerender(<task.Fixture active={false} />)
    expect(popup.closest('[data-mobile-page-active="false"]')).toHaveAttribute("inert")
    expect(task.back()).toBeUndefined()
  })
})
