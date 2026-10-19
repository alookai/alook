import { beforeEach, afterEach, describe, expect, it } from "vitest"
import { fireEvent } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"
beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)
describe("current local submission awaits native newest query completion", () => {
  it.each([1, 140, 210])("completes the current window after %s pending frames", frames => {
    const old = Array.from({ length: 50 }, (_, n) => message(`m${n + 1}`))
    const newest = Array.from({ length: 50 }, (_, n) => message(`m${n + 81}`))
    const h = mount({ items: old, newDividerBefore: "m19", hasMoreNewer: true })
    h.move(2900)
    h.update({ items: [...old, message("local", "me")], localSubmitVersion: 1, isFetchingNewer: true })
    runFrames(frames)
    const whilePending = { paginationEnabled: scrollFixture.latest.paginationEnabled, readPositionReady: scrollFixture.latest.readPositionReady }
    h.update({ items: [...newest, message("local", "me")], hasMoreNewer: false, isFetchingNewer: false, presentVersion: 1 })
    for (let frame = 0; frame < 26; frame++) resize(1)
    const distance = h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop
    expect({ whilePending, distance, ready: scrollFixture.latest.readPositionReady }).toMatchObject({ whilePending: { paginationEnabled: false, readPositionReady: false }, distance: expect.any(Number), ready: true })
    expect(distance).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
  })
  it("releases a failed newest operation before its geometry timeout", () => {
    const h = mount({ hasMoreNewer: true })
    h.move(300)
    const before = h.root.scrollTop
    h.update({ localSubmitVersion: 1, isFetchingNewer: true })
    runFrames(3)
    h.update({ isFetchingNewer: false })
    expect(scrollFixture.latest.paginationEnabled).toBe(true)
    expect(h.root.scrollTop).toBe(before)
    expect(scrollFixture.latest.readPositionReady).toBe(false)
  })
  it("does not reclaim a pending local operation after reader handover", () => {
    const h = mount({ hasMoreNewer: true })
    h.move(300)
    h.update({ localSubmitVersion: 1, isFetchingNewer: true })
    runFrames(140)
    fireEvent.wheel(h.root, { deltaY: -24 })
    const before = h.root.scrollTop
    h.update({ hasMoreNewer: false, isFetchingNewer: false, presentVersion: 1 })
    expect(h.root.scrollTop).toBe(before)
  })
})
