import { describe, expect, it } from "vitest"
import { attachInstruction } from "@atlaskit/pragmatic-drag-and-drop-hitbox/list-item"
import {
  railEntityFromData,
  railInstructionFromRecords,
  railTouchMoveIntent,
  SERVER_RAIL_TOUCH_DRIFT_PX,
  SERVER_RAIL_TOUCH_HOLD_MS,
} from "./use-server-rail-pdd"

describe("server rail PDD record adapter", () => {
  it("reads only typed rail entities", () => {
    expect(railEntityFromData({ railKind: "server", railId: "one" })).toEqual({
      kind: "server",
      id: "one",
    })
    expect(railEntityFromData({ railKind: "channel", railId: "one" })).toBeNull()
  })

  it("extracts one before/after/combine instruction from the foremost target", () => {
    const targetData = attachInstruction(
      { railKind: "folder", railId: "group" },
      {
        input: { clientX: 20, clientY: 20 } as any,
        element: {
          getBoundingClientRect: () => ({ top: 0, bottom: 40, height: 40 }),
        } as HTMLElement,
        axis: "vertical",
        operations: {
          "reorder-before": "not-available",
          "reorder-after": "not-available",
          combine: "available",
        },
      },
    )
    expect(railInstructionFromRecords(
      { railKind: "server", railId: "one" },
      [{ data: targetData }],
    )).toEqual({
      operation: "combine",
      source: { kind: "server", id: "one" },
      target: { kind: "folder", id: "group" },
    })
  })

  it("rejects self and missing targets", () => {
    expect(railInstructionFromRecords({ railKind: "server", railId: "one" }, [])).toBeNull()
  })

  it("keeps ordinary scroll outside the 450ms/10px drag intent", () => {
    expect(SERVER_RAIL_TOUCH_HOLD_MS).toBe(450)
    expect(SERVER_RAIL_TOUCH_DRIFT_PX).toBe(10)
    expect(railTouchMoveIntent({
      armed: false,
      dragging: false,
      distance: 10,
      touchCount: 1,
    })).toBe("wait")
    expect(railTouchMoveIntent({
      armed: false,
      dragging: false,
      distance: 10.1,
      touchCount: 1,
    })).toBe("scroll")
    expect(railTouchMoveIntent({
      armed: true,
      dragging: false,
      distance: 10.1,
      touchCount: 1,
    })).toBe("start-drag")
    expect(railTouchMoveIntent({
      armed: true,
      dragging: true,
      distance: 30,
      touchCount: 2,
    })).toBe("cancel")
  })
})
