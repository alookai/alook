import { beforeEach, describe, expect, it } from "vitest"
import {
  captureActiveMessageScrollPosition,
  clearMessageScrollPositions,
  readMessageScrollPosition,
  registerActiveMessageScrollCapture,
  writeMessageScrollPosition,
} from "./message-scroll-memory"

describe("message scroll memory", () => {
  beforeEach(clearMessageScrollPositions)

  it("keeps the latest non-negative position for a surface", () => {
    writeMessageScrollPosition("channel:a", 220)
    writeMessageScrollPosition("channel:a", 180)
    writeMessageScrollPosition("channel:b", -10)
    expect(readMessageScrollPosition("channel:a")).toBe(180)
    expect(readMessageScrollPosition("channel:b")).toBe(0)
  })

  it("bounds old surface positions", () => {
    for (let index = 0; index < 51; index += 1) {
      writeMessageScrollPosition(`channel:${index}`, index)
    }
    expect(readMessageScrollPosition("channel:0")).toBeUndefined()
    expect(readMessageScrollPosition("channel:50")).toBe(50)
  })

  it("captures every connected visible scroller and unregisters exactly", () => {
    const connected = { isConnected: true, clientHeight: 692, scrollTop: 2200 } as HTMLElement
    const hidden = { isConnected: true, clientHeight: 0, scrollTop: 900 } as HTMLElement
    const detached = { isConnected: false, clientHeight: 692, scrollTop: 700 } as HTMLElement
    const unregisterConnected = registerActiveMessageScrollCapture("channel:a", connected)
    const unregisterHidden = registerActiveMessageScrollCapture("channel:hidden", hidden)
    const unregisterDetached = registerActiveMessageScrollCapture("channel:detached", detached)

    captureActiveMessageScrollPosition()
    expect(readMessageScrollPosition("channel:a")).toBe(2200)
    expect(readMessageScrollPosition("channel:hidden")).toBeUndefined()
    expect(readMessageScrollPosition("channel:detached")).toBeUndefined()

    unregisterConnected()
    unregisterHidden()
    unregisterDetached()
    connected.scrollTop = 1400
    captureActiveMessageScrollPosition()
    expect(readMessageScrollPosition("channel:a")).toBe(2200)
  })
})
