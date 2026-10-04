import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { bodyTop, installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

beforeEach(() => {
  installMessageScrollFixture()
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone AppleWebKit")
})
afterEach(restoreMessageScrollFixture)

describe("locked native iOS deferred adjustment controls, with simulated DOM geometry", () => {
  it("does not clear deferred prepend compensation with an ordinary user handover offset", () => {
    const h = mount()
    h.move(500)
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    fireEvent.touchStart(h.root, { touches: [{ clientY: 300 }] })
    const before = h.root.scrollTop
    h.update({ items: [message("older"), ...h.input.items] })
    expect(offset).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(before)
    fireEvent.touchEnd(h.root, { touches: [] })
    runFrames()
    expect(h.root.scrollTop).toBeGreaterThan(before)
    expect(offset).not.toHaveBeenCalled()
  })
  it("lets native flush pinned long-row growth before accepting a new prefix baseline", () => {
    scrollFixture.bodyHeights.set("m0", 1800)
    const h = mount({ items: [message("m0")] })
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    const before = h.root.scrollTop
    fireEvent.touchStart(h.root, { touches: [{ clientY: 200 }] })
    scrollFixture.firstPrefix += 60
    h.update({ items: [...h.input.items] })
    expect(h.root.scrollTop).toBe(before)
    expect(offset).not.toHaveBeenCalled()
    fireEvent.touchEnd(h.root, { touches: [] })
    runFrames()
    expect(h.root.scrollTop - before).toBe(60)
    expect(offset).not.toHaveBeenCalled()
  })
  it("drops an old prefix candidate when a new gesture chooses a different reading offset", () => {
    scrollFixture.bodyHeights.set("m0", 1200)
    const h = mount()
    h.move(400)
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    fireEvent.touchStart(h.root, { touches: [{ clientY: 200 }] })
    scrollFixture.firstPrefix += 40
    h.update({ items: [...h.input.items] })
    fireEvent.wheel(h.root, { deltaY: 40 })
    act(() => h.root.scrollTo({ top: 600 }))
    fireEvent.touchEnd(h.root, { touches: [] })
    runFrames()
    expect(offset).not.toHaveBeenCalled()
    expect(h.root.scrollTop).toBe(600)
    expect(bodyTop(h.root, "m0")).toBeLessThan(0)
  })
  it("yields footer settlement during touch and does not restore an old offset after the gesture", () => {
    const h = mount()
    h.move(500)
    const offset = vi.spyOn(scrollFixture.latest.virtualizer, "scrollToOffset")
    fireEvent.touchStart(h.root, { touches: [{ clientY: 200 }] })
    scrollFixture.height -= 100
    resize()
    expect(offset).not.toHaveBeenCalled()
    fireEvent.touchEnd(h.root, { touches: [] })
    runFrames()
    expect(h.root.scrollTop).toBe(500)
    expect(offset).not.toHaveBeenCalled()
  })
})
