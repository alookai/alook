import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"

vi.mock("./dm-header", () => ({
  DmHeaderSkeleton: ({ onBack }: { onBack?: () => void }) => createElement("div", {
    "data-testid": "dm-header-skeleton",
    "data-reserves-back": String(typeof onBack === "function"),
  }),
}))
vi.mock("@/components/community/messages/message-list", () => ({
  MessageList: ({ loading, variant }: { loading?: boolean; variant?: string }) =>
    createElement("div", {
      "data-testid": "message-list",
      "data-loading": String(Boolean(loading)),
      "data-variant": variant,
    }),
}))
vi.mock("@/components/community/messages/composer", () => ({
  ComposerSkeleton: () => createElement("div", { "data-testid": "composer-skeleton" }),
}))

import { DmLoadingFrame } from "./dm-loading-frame"

describe("DmLoadingFrame", () => {
  it("uses DM header, message, and composer skeletons", () => {
    render(createElement(DmLoadingFrame, { reserveBackSlot: true }))

    expect(screen.getByTestId("dm-header-skeleton"))
      .toHaveAttribute("data-reserves-back", "true")
    expect(screen.getByTestId("message-list")).toHaveAttribute("data-loading", "true")
    expect(screen.getByTestId("message-list")).toHaveAttribute("data-variant", "dm")
    expect(screen.getByTestId("composer-skeleton")).toBeInTheDocument()
    expect(screen.getByLabelText("Loading direct message"))
      .toHaveAttribute("aria-busy", "true")
  })
})
