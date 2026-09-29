import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@/test/react-dom-harness"
import { foldersResourceKey } from "@/lib/community-db/folders-resource"

const dbRail = vi.hoisted(() => ({
  current: {
    servers: [],
    folders: [{ id: "db-folder", name: "Canonical", position: 0, servers: [] }],
  },
}))
const registryActive = vi.hoisted(() => ({ current: true }))
vi.mock("@/lib/community-db/projections", () => ({
  useServerRailProjection: () => dbRail.current,
  useOptionalCommunityDbRegistry: () => registryActive.current ? {} : null,
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

  it("uses transport folders without a canonical registry", () => {
    registryActive.current = false
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    client.setQueryData(foldersResourceKey("anon"), {
      folders: [{ id: "query-folder", name: "Query", position: 0, servers: [] }],
    })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client },
      children,
    )
    const rendered = renderHook(useFolders, { wrapper })

    expect(rendered.result.current.folders).toEqual([
      { id: "query-folder", name: "Query", position: 0, servers: [] },
    ])
    rendered.unmount()
    registryActive.current = true
  })
})
