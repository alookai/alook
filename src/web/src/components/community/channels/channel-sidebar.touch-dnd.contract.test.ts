import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8")

describe("channel sidebar touch drag contracts", () => {
  it("uses input-specific sensors with the agreed activation constraints", () => {
    const sidebar = readSource("./channel-sidebar.tsx")

    expect(sidebar).toContain(
      "useSensor(MouseSensor, { activationConstraint: { distance: 5 } })",
    )
    expect(sidebar).toContain(
      "useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })",
    )
    expect(sidebar).toContain(
      "useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })",
    )
    expect(sidebar).toContain("collisionDetection={channelSidebarCollisionDetection}")
    expect(sidebar).toContain('activeData?.kind !== "category"')
    expect(sidebar).toContain("containerId === containerId")
    expect(sidebar).toContain("catOrder.includes(activeStr)")
    expect(sidebar).not.toContain("PointerSensor")
  })

  it("keeps the whole channel row and category header draggable without blocking touch scroll", () => {
    const channel = readSource("./sortable-channel.tsx")
    const category = readSource("./sortable-category.tsx")

    expect(channel).toContain("onClick={onClick}")
    expect(category).toContain("onClick: onToggle")
    expect(category).toContain('data: { kind: "category" }')
    expect(category).toContain("ref: setActivatorNodeRef")
    expect(category).toContain("onTouchStartCapture: listeners?.onTouchStart")
    expect(category).not.toContain("useDroppable")

    for (const source of [channel, category]) {
      expect(source).toContain("...attributes")
      expect(source).toContain("...listeners")
      expect(source).toContain("touch-manipulation")
      expect(source).not.toContain("touch-none")
    }
  })
})
