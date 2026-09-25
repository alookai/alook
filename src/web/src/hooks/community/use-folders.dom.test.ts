import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@/test/react-dom-harness"

const dbRail = vi.hoisted(() => ({
  current: {
    servers: [],
    folders: [{ id: "db-folder", name: "Canonical", position: 0, servers: [] }],
  },
}))
vi.mock("@/lib/community-db/projections", () => ({
  useServerRailProjection: () => dbRail.current,
}))
vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }))

import { useFolders } from "./use-folders"

describe("useFolders canonical projection", () => {
  it("prefers the canonical rail while the transport query is pending", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client },
      children,
    )
    const rendered = renderHook(useFolders, { wrapper })

    expect(rendered.result.current.folders).toEqual(dbRail.current.folders)
    rendered.unmount()
    client.clear()
  })
})
