import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import type { PropsWithChildren } from "react"
import { act, screen } from "@/test/react-dom-harness"
import { renderToString } from "react-dom/server"
import { hydrateRoot } from "react-dom/client"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { bodyTop, installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, scrollFixture } from "@/test/message-scroll-fixture"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { MobilePage } from "./mobile-page"

const viewport = vi.hoisted(() => ({ breakpoint: "desktop" as "unknown" | "desktop" | "mobile" }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.breakpoint === "mobile" }))
beforeEach(() => { viewport.breakpoint = "desktop"; installMessageScrollFixture() })
afterEach(restoreMessageScrollFixture)

describe("first mobile Portal adoption with the native message virtualizer", () => {
  it("hydrates the original SSR control and retains its draft, focus and selection through both breakpoint directions", async () => {
    const owner = await createCommunityQueryOwner()
    const navigation = { captureIntent: () => () => true, replace: vi.fn(), pendingHref: null, publishedHref: "/c/channels/s1/c1" }
    function Page() {
      return <CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>
        <CommunityRouteContext value={{ breakpoint: viewport.breakpoint, navigation, frame: { revision: 0 } } as never}>
          <MobilePage parentPath="/c/channels/s1"><input aria-label="SSR draft" defaultValue="Initial" /></MobilePage>
        </CommunityRouteContext>
      </CommunityTestProvider>
    }
    viewport.breakpoint = "unknown"
    const container = document.createElement("div")
    container.innerHTML = renderToString(<Page />)
    document.body.appendChild(container)
    const input = container.querySelector("input")!
    expect(input).not.toBeNull()
    expect(input.closest('[data-slot="mobile-page"]')).toHaveAttribute("data-open")
    expect(input.closest('[data-slot="mobile-page"]')).not.toHaveAttribute("data-starting-style")
    input.value = "Typed before hydration"
    input.focus()
    input.setSelectionRange(2, 5)
    let root!: ReturnType<typeof hydrateRoot>
    await act(async () => { root = hydrateRoot(container, <Page />) })
    for (const breakpoint of ["desktop", "mobile", "desktop", "mobile"] as const) {
      viewport.breakpoint = breakpoint
      await act(async () => root.render(<Page />))
      expect(container.querySelector("input")).toBe(input)
      expect(input).toHaveValue("Typed before hydration")
      expect(input).toHaveFocus()
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5])
    }
    await act(async () => root.unmount())
    container.remove()
  })

  it.each(["reader", "tail"])("retains the %s through the first mobile layout and width-dependent measurements", async position => {
    const owner = await createCommunityQueryOwner()
    const navigation = { captureIntent: () => () => true, replace: vi.fn(), pendingHref: null, publishedHref: "/c/channels/s1/c1" }
    function Wrapper({ children }: PropsWithChildren) {
      return <CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>
        <CommunityRouteContext value={{ breakpoint: viewport.breakpoint, navigation, frame: { revision: 0 } } as never}>
          <MobilePage parentPath="/c/channels/s1">{children}</MobilePage>
        </CommunityRouteContext>
      </CommunityTestProvider>
    }
    const h = mount({ items: Array.from({ length: 50 }, (_, i) => message(`m${i}`)), hasMoreOlder: false }, false, undefined, Wrapper)
    if (position === "reader") h.move(730)
    const native = scrollFixture.latest.virtualizer
    const fold = native.getVirtualItems().find(row => row.key.toString().startsWith("msg:") && row.end > h.root.scrollTop)!
    const id = String(fold.key).slice(4)
    const before = bodyTop(h.root, id)
    viewport.breakpoint = "mobile"
    scrollFixture.width = 390
    for (let i = 0; i < 50; i++) scrollFixture.bodyHeights.set(`m${i}`, 130)
    h.stage({})
    resize()
    const root = screen.getByTestId("scroll")
    expect(root).toBe(h.root)
    expect(root.closest('[data-slot="mobile-page"]')).not.toBeNull()
    if (position === "reader") expect(bodyTop(root, id)).toBeCloseTo(before, 0)
    else expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(navigation.replace).not.toHaveBeenCalled()
  })
})
