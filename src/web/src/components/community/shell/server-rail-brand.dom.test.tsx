import { type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import * as mobile from "@/hooks/use-mobile"
import { tid } from "@/lib/community/testids"
import { AnimatedAlookLogo, transformForProgress } from "./animated-alook-logo"
import { ServerRail } from "./server-rail"

vi.mock("@/hooks/community/mutations", () => ({
  useServerRailCommit: () => ({ isCommandPending: () => false }),
}))
vi.mock("@/lib/community/navigation-metadata", () => ({ prepareNavigationMetadata: vi.fn() }))
vi.mock("../community-dnd", () => ({
  CommunityDndProvider: ({ children }: { children: ReactNode }) => children,
  useCommunityDndScrolling: () => {},
}))
vi.mock("./use-server-rail-dnd", () => ({
  RailEndDropTarget: () => null,
  RailFolderGapDropTarget: () => null,
  useServerRailDrag: () => ({ entity: null, offset: null }),
  useServerRailDnd: () => ({ cancel: () => {} }),
}))
vi.mock("./rail-icon", () => ({ RailIcon: () => null }))
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}))
vi.mock("next/link", async () => ({ default: (await import("@/test/community-link-mock")).CommunityLinkMock }))

const nativeKeys = ["__TAURI__", "AlookNative"] as const
const originalNative = new Map(nativeKeys.map((key) => [key, Object.getOwnPropertyDescriptor(window, key)]))
const queries = new Set<MediaQueryList>()
let width = 640
let safeAreaTop: number | null = 0

beforeEach(() => {
  width = 640
  safeAreaTop = 0
  queries.clear()
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
  Object.defineProperty(window, "AlookNative", {
    configurable: true,
    value: { getSafeAreaTop: () => safeAreaTop },
  })
  vi.spyOn(window, "matchMedia").mockImplementation((media) => {
    const query = Object.assign(new EventTarget(), {
      media, matches: false, onchange: null, addListener() {}, removeListener() {},
    }) as MediaQueryList
    Object.defineProperty(query, "matches", {
      get: () => media === "(max-width: 639px)" ? width < 640 : media.includes("prefers-reduced-motion"),
    })
    queries.add(query)
    return query
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [key, descriptor] of originalNative) {
    if (descriptor) Object.defineProperty(window, key, descriptor)
    else Reflect.deleteProperty(window, key)
  }
})

function renderRail() {
  return render(<>
    <ServerRail servers={[]} folders={[]} view="server" onHome={vi.fn()} />
    <button data-testid="other-logo"><AnimatedAlookLogo /></button>
  </>)
}

function expectCharacterOnly(logo: SVGSVGElement, expected: boolean) {
  expect(logo.querySelectorAll("[data-face]")).toHaveLength(5)
  expect(logo.querySelectorAll('[data-face][opacity="0"]')).toHaveLength(expected ? 4 : 0)
}

describe("Home Logo width and native inset", () => {
  it.each([
    [639, 0, false],
    [640, 0, true],
    [639, 47, false],
    [640, 47, false],
    [639, null, false],
    [640, null, false],
  ] as const)("renders width %s with safe area %s", (nextWidth, nextTop, expected) => {
    width = nextWidth
    safeAreaTop = nextTop
    const view = renderRail()
    const logo = view.getByTestId(tid.homeButton).querySelector("svg")!
    expectCharacterOnly(logo, expected)
  })

  it("keeps the normal mark while the breakpoint is unknown", () => {
    vi.spyOn(mobile, "useBreakpoint").mockReturnValue("unknown")
    const view = renderRail()
    expectCharacterOnly(view.getByTestId(tid.homeButton).querySelector("svg")!, false)
  })

  it("updates the same mounted Home mark across 639 and 640", () => {
    width = 639
    const view = renderRail()
    const home = view.getByTestId(tid.homeButton)
    const logo = home.querySelector("svg")!
    expectCharacterOnly(logo, false)
    act(() => {
      width = 640
      for (const query of queries) query.dispatchEvent(new Event("change"))
    })
    expectCharacterOnly(logo, true)
    fireEvent.pointerEnter(home)
    fireEvent.focus(home)
    expect(logo.querySelector('[data-face="orange"]')).toHaveAttribute("transform", transformForProgress(0))

    act(() => {
      width = 639
      for (const query of queries) query.dispatchEvent(new Event("change"))
    })
    expect(view.getByTestId(tid.homeButton).querySelector("svg")).toBe(logo)
    expectCharacterOnly(logo, false)
  })

  it("follows inset changes while a separate shared Logo retains its normal behavior", () => {
    const view = renderRail()
    const home = view.getByTestId(tid.homeButton).querySelector("svg")!
    const otherButton = view.getByTestId("other-logo")
    const other = otherButton.querySelector("svg")!
    expectCharacterOnly(home, true)
    expectCharacterOnly(other, false)
    fireEvent.focus(otherButton)
    expect(other.querySelector('[data-face="orange"]')).toHaveAttribute("transform", transformForProgress(1))

    for (const nextTop of [47, 0, null]) {
      act(() => {
        safeAreaTop = nextTop
        window.dispatchEvent(new Event("alook:safe-area-change"))
      })
      expectCharacterOnly(home, nextTop === 0)
      expectCharacterOnly(other, false)
    }
  })
})
