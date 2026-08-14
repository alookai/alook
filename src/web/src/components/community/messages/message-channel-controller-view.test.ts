import { describe, expect, it, vi } from "vitest"
import { renderMessageChannelController } from "./message-channel-controller-view"
import type { MessageChannelControllerValue } from "./message-channel-controller-types"

describe("renderMessageChannelController", () => {
  it("calls the render prop once with the identical value and returns its node directly", () => {
    const value = { feed: {} } as MessageChannelControllerValue
    const node = { kind: "sentinel" }
    const children = vi.fn(() => node)
    expect(renderMessageChannelController(children, value)).toBe(node)
    expect(children).toHaveBeenCalledOnce()
    expect(children).toHaveBeenCalledWith(value)
  })
})
