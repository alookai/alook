import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  toasterProps: vi.fn(),
  resolvedTheme: "light" as string | undefined,
  isMobile: false,
}))

vi.mock("sonner", () => ({
  Toaster: (props: Record<string, unknown>) => {
    mocks.toasterProps(props)
    return React.createElement("sonner-toaster")
  },
}))

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: mocks.resolvedTheme }),
}))

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mocks.isMobile,
}))

import { ToasterProvider } from "./toaster-provider"

describe("ToasterProvider", () => {
  beforeEach(() => {
    mocks.toasterProps.mockReset()
    mocks.resolvedTheme = "light"
    mocks.isMobile = false
  })

  it("configures Sonner without stock richColors and supplies Alook status icons", () => {
    render(React.createElement(ToasterProvider))

    expect(mocks.toasterProps).toHaveBeenCalledTimes(1)
    const props = mocks.toasterProps.mock.calls[0]![0] as Record<string, unknown>
    expect(props.richColors).toBeUndefined()
    expect(props.closeButton).toBe(true)
    expect(props.theme).toBe("light")
    expect(props.position).toBe("bottom-right")
    const icons = props.icons as Record<string, unknown>
    expect(Object.keys(icons).sort()).toEqual(["close", "error", "info", "loading", "success", "warning"])
  })

  it("switches to top-center on mobile and falls back to system theme", () => {
    mocks.resolvedTheme = undefined
    mocks.isMobile = true

    render(React.createElement(ToasterProvider))

    const props = mocks.toasterProps.mock.calls[0]![0] as Record<string, unknown>
    expect(props.theme).toBe("system")
    expect(props.position).toBe("top-center")
  })
})
