import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, message, mount, resize, scrollFixture } from "@/test/message-scroll-fixture"
import type { MessageRequest, MessageRequestResult, NewPositionRequest, NewPositionResult } from "@/lib/community/message-position"
import { CONVERSATION_READ_TIMEOUT_MS } from "@/lib/community/conversation-read"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)

function start(id: string, load?: () => MessageRequest) {
  let request!: NewPositionRequest
  act(() => { request = scrollFixture.latest.requestNewPosition(id, load) })
  if (!request.accepted) throw new Error("New positioning was not accepted")
  return request
}
const items = () => Array.from({ length: 50 }, (_, index) => ({ ...message(`m${index}`), newDivider: index === 5 }))

it("enters at the real bottom and keeps late New metadata from taking scroll ownership", () => {
  const h = mount({ items: items(), newDividerBefore: "m5" })
  try {
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.newDividerVisibility).toBe("offscreen")
    h.update({ newDividerBefore: undefined })
    h.update({ newDividerBefore: "m5" })
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it.each([5, 49])("finishes only with actual New divider-start geometry, target index=%s", async target => {
  const id = `m${target}`
  const rows = items().map((item, index) => ({ ...item, newDivider: index === target }))
  const h = mount({ items: rows, newDividerBefore: id })
  try {
    h.move(100)
    let outcome: NewPositionResult | undefined
    const request = start(id)
    void request.completed.then(result => { outcome = result })
    resize()
    await act(async () => {})
    expect(outcome).toBe("success")
    const divider = h.root.querySelector<HTMLElement>(`[data-message-divider-for="${id}"] [data-new-divider]`)!
    expect(Math.abs(divider.getBoundingClientRect().top - h.root.getBoundingClientRect().top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.newDividerVisibility).toBe("visible")
    expect(scrollFixture.latest.readPositionReady).toBe(true)
    expect(scrollFixture.latest.followingTail).toBe(false)
    h.update({ items: [...rows, message("arrived-after-New")] })
    expect(Math.abs(divider.getBoundingClientRect().top - h.root.getBoundingClientRect().top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
  } finally { h.view.unmount() }
})

it("waits for the exact main window and committed target rows after accepting a load", async () => {
  const h = mount({ items: Array.from({ length: 50 }, (_, index) => message(`tail${index}`)), newDividerBefore: "m5" })
  let complete!: (result: MessageRequestResult) => void
  const loaded = new Promise<MessageRequestResult>(resolve => { complete = resolve })
  try {
    let outcome: NewPositionResult | undefined
    const request = start("m5", () => ({ accepted: true, completed: loaded }))
    void request.completed.then(result => { outcome = result })
    resize()
    expect(outcome).toBeUndefined()
    const window = {}
    await act(async () => { complete({ status: "success", window }) })
    resize()
    expect(outcome).toBeUndefined()
    h.update({ items: items(), messageWindow: window })
    await act(async () => {})
    expect(outcome).toBe("success")
    const divider = h.root.querySelector<HTMLElement>('[data-message-divider-for="m5"] [data-new-divider]')!
    expect(Math.abs(divider.getBoundingClientRect().top - h.root.getBoundingClientRect().top)).toBeLessThanOrEqual(1)
  } finally { h.view.unmount() }
})

it("cancels the data selection and ignores late completion after the user takes over", async () => {
  const h = mount({ items: Array.from({ length: 50 }, (_, index) => message(`tail${index}`)), newDividerBefore: "m5" })
  let complete!: (result: MessageRequestResult) => void
  const loaded = new Promise<MessageRequestResult>(resolve => { complete = resolve }), cancel = vi.fn()
  try {
    const request = start("m5", () => ({ accepted: true, completed: loaded, cancel }))
    h.move(h.root.scrollTop - 80)
    expect(await request.completed).toBe("cancelled")
    expect(cancel).toHaveBeenCalledOnce()
    const reader = h.root.scrollTop
    await act(async () => { complete({ status: "success", window: {} }) })
    resize()
    expect(h.root.scrollTop).toBe(reader)
  } finally { h.view.unmount() }
})

it("keeps data and layout failures retryable instead of consuming an issued scroll", async () => {
  const h = mount({ items: items(), newDividerBefore: "m5" })
  try {
    const failed = start("m5", () => ({ accepted: true, completed: Promise.resolve({ status: "error" }) }))
    await act(async () => {})
    expect(await failed.completed).toBe("error")
    resize()
    scrollFixture.height = 0
    h.update({})
    const unpositioned = start("m5")
    resize()
    await act(async () => { await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS) })
    expect(await unpositioned.completed).toBe("error")
    scrollFixture.height = 500
    resize()
    let outcome: NewPositionResult | undefined
    const retry = start("m5")
    void retry.completed.then(result => { outcome = result })
    resize()
    await act(async () => {})
    expect(outcome).toBe("success")
  } finally { h.view.unmount() }
})

it("keeps short-suffix New reading at its viewport origin through viewport size changes", async () => {
  const rows = items().map((item, index) => ({ ...item, newDivider: index === 49 }))
  const h = mount({ items: rows, newDividerBefore: "m49" })
  try {
    const request = start("m49")
    resize()
    await act(async () => {})
    expect(await request.completed).toBe("success")
    for (const height of [680, 320, 500]) {
      scrollFixture.height = height
      resize()
      const divider = h.root.querySelector<HTMLElement>('[data-message-divider-for="m49"] [data-new-divider]')!
      expect(Math.abs(divider.getBoundingClientRect().top - h.root.getBoundingClientRect().top)).toBeLessThanOrEqual(1)
      expect(scrollFixture.latest.followingTail).toBe(false)
      expect(scrollFixture.latest.readPositionReady).toBe(true)
    }
  } finally { h.view.unmount() }
})

it("restores an owned New suffix reserve after append exhausts it and the viewport grows", async () => {
  const rows = items().map((item, index) => ({ ...item, newDivider: index === 49 }))
  const h = mount({ items: rows, newDividerBefore: "m49" })
  try {
    const naturalHeight = h.root.scrollHeight
    const request = start("m49")
    resize()
    await act(async () => {})
    expect(await request.completed).toBe("success")
    h.update({ items: [...rows, ...Array.from({ length: 4 }, (_, index) => message(`later${index}`))] })
    expect(h.root.scrollHeight).toBe(naturalHeight + 400)
    scrollFixture.height = 680
    resize()
    const divider = h.root.querySelector<HTMLElement>('[data-message-divider-for="m49"] [data-new-divider]')!
    expect(Math.abs(divider.getBoundingClientRect().top - h.root.getBoundingClientRect().top)).toBeLessThanOrEqual(1)
    expect(scrollFixture.latest.followingTail).toBe(false)
    expect(scrollFixture.latest.readPositionReady).toBe(true)
  } finally { h.view.unmount() }
})

it.each(["explicit", "present"] as const)("releases measured lookback end space when %s takes position ownership", async action => {
  const rows = items().map((item, index) => ({ ...item, newDivider: index === 49 }))
  const h = mount({ items: rows, newDividerBefore: "m49" })
  try {
    const naturalHeight = h.root.scrollHeight
    const request = start("m49")
    resize()
    await act(async () => {})
    expect(await request.completed).toBe("success")
    expect(h.root.scrollHeight).toBeGreaterThan(naturalHeight)
    if (action === "explicit") h.update({ scrollToMessageId: "m49" })
    else act(() => scrollFixture.latest.scrollToBottom())
    resize()
    expect(h.root.scrollHeight).toBe(naturalHeight)
    expect(h.root.scrollHeight - h.root.clientHeight - h.root.scrollTop).toBeLessThanOrEqual(1)
  } finally { h.view.unmount() }
})
