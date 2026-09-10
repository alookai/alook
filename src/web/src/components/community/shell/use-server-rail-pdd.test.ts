import { describe, expect, it } from "vitest"
import { attachInstruction } from "@atlaskit/pragmatic-drag-and-drop-hitbox/list-item"
import {
  railEntityHasAvailableTarget,
  railEntityFromData,
  railInstructionFromRecords,
  railTouchMoveIntent,
  SERVER_RAIL_TOUCH_DRAG_PX,
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

  it("requires the 650ms arm before the 8px drag threshold", () => {
    expect(SERVER_RAIL_TOUCH_HOLD_MS).toBe(650)
    expect(SERVER_RAIL_TOUCH_DRAG_PX).toBe(8)
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
      distance: 7,
      touchCount: 1,
    })).toBe("wait")
    expect(railTouchMoveIntent({
      armed: true,
      dragging: false,
      distance: 8,
      touchCount: 1,
    })).toBe("drag")
    expect(railTouchMoveIntent({
      armed: true,
      dragging: true,
      distance: 30,
      touchCount: 1,
    })).toBe("drag")
    expect(railTouchMoveIntent({
      armed: true,
      dragging: true,
      distance: 30,
      touchCount: 2,
    })).toBe("cancel")
  })

  it("arms touch only when the source has a legal registered target", () => {
    expect(railEntityHasAvailableTarget({
      serverOrder: ["a"],
      folderOrder: [],
      folders: {},
      expanded: [],
    }, { kind: "server", id: "a" }, [
      { kind: "server", id: "a" },
    ])).toBe(false)

    expect(railEntityHasAvailableTarget({
      serverOrder: ["a", "b"],
      folderOrder: [],
      folders: {},
      expanded: [],
    }, { kind: "server", id: "a" }, [
      { kind: "server", id: "a" },
      { kind: "server", id: "b" },
    ])).toBe(true)

    expect(railEntityHasAvailableTarget({
      serverOrder: ["a", "b"],
      folderOrder: ["f"],
      folders: { f: ["a"] },
      expanded: ["f"],
    }, { kind: "server", id: "a" }, [
      { kind: "server", id: "a" },
      { kind: "server", id: "b" },
    ])).toBe(true)

    expect(railEntityHasAvailableTarget({
      serverOrder: ["a"],
      folderOrder: ["f"],
      folders: { f: ["a"] },
      expanded: ["f"],
    }, { kind: "folder", id: "f" }, [
      { kind: "folder", id: "f" },
      { kind: "server", id: "a" },
    ])).toBe(false)
  })
})
