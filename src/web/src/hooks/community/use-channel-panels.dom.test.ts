import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { renderHook } from "@/test/react-dom-harness"
import { usePins } from "./use-channel-panels"

describe("usePins", () => {
  it("exposes a stable empty list while the query is disabled", () => {
    const queryClient = new QueryClient()
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const rendered = renderHook(() => usePins(null), { wrapper })

    expect(rendered.result.current.pins).toEqual([])
    rendered.unmount()
  })
})
