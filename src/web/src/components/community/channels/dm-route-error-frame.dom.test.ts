import { createElement, type PropsWithChildren } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"

vi.mock("lucide-react", () => ({ AlertCircle: () => createElement("span") }))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, size: _size, variant: _variant, ...props }:
    PropsWithChildren<Record<string, unknown>>) => createElement("button", props, children),
}))
vi.mock("./dm-header", () => ({
  DmHeaderSkeleton: () => createElement("div", { "data-testid": "dm-header-skeleton" }),
}))
vi.mock("@/components/community/messages/composer", () => ({
  ComposerSkeleton: () => createElement("div", { "data-testid": "composer-skeleton" }),
}))

import { DmRouteErrorFrame } from "./dm-route-error-frame"

describe("DmRouteErrorFrame", () => {
  it("retries locally and disables the action while retrying", async () => {
    const retry = vi.fn()
    const user = setupUser()
    const rendered = render(createElement(DmRouteErrorFrame, {
      onRetry: retry,
      retrying: false,
    }))

    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalledOnce()

    rendered.rerender(createElement(DmRouteErrorFrame, {
      onRetry: retry,
      retrying: true,
    }))
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled()
    expect(screen.getByRole("alert")).toBeVisible()
  })
})
