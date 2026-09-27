import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { renderHook } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { usePins, useThreads } from "./use-channel-panels"

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
    expect(renderHook(() => useThreads(null), { wrapper }).result.current.threads).toEqual([])
    const disabledPins = queryClient.getQueryCache().find({
      queryKey: communityKeys.pins("__none__"),
    })?.options.queryFn
    const disabledThreads = queryClient.getQueryCache().find({
      queryKey: communityKeys.threads("__none__"),
    })?.options.queryFn
    expect(disabledPins).toBeTypeOf("function")
    expect(disabledThreads).toBeTypeOf("function")
    expect(disabledPins!({} as never)).rejects.toThrow("disabled")
    expect(disabledThreads!({} as never)).rejects.toThrow("disabled")
    rendered.unmount()
  })
})
