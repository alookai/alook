import React from "react"
import { describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { ComposerAccessoryRail } from "./composer-accessory-rail"

vi.mock("@/components/ui/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => React.createElement("span", null, value),
}))

describe("ComposerAccessoryRail geometry", () => {
  it("shares the composer's logical safe-area-aware inline edges", () => {
    const renderer = render(
      <ComposerAccessoryRail
        typingNames={["Alice"]}
        scrollCount={2}
        scrollMode="scroll"
        onScroll={vi.fn()}
      />,
    )

    expect(renderer.getByTestId(tid.composerAccessoryRail)).toHaveClass(
      "pl-(--community-composer-inline-start)",
      "pr-(--community-composer-inline-end)",
    )
    expect(renderer.getByTestId(tid.composerAccessoryRail)).not.toHaveClass(
      "px-2",
      "sm:px-4",
    )
  })

  it("keeps rail visibility out of layout flow", () => {
    const renderer = render(
      <ComposerAccessoryRail
        typingNames={[]}
        scrollCount={1}
        scrollMode="jump"
        onScroll={vi.fn()}
      />,
    )

    expect(renderer.getByTestId(tid.composerAccessoryRail)).toHaveClass(
      "absolute",
      "inset-x-0",
      "bottom-2",
      "sm:bottom-4",
    )
  })
})
