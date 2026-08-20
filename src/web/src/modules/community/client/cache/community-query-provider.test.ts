import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  queryClient: { id: "query-client" },
  persister: { id: "persister" },
  createQueryClient: vi.fn(),
  createCommunityQueryPersister: vi.fn(),
  shouldPersistQuery: vi.fn(),
  providerProps: null as Record<string, any> | null,
}))

vi.mock("@/platform/client", () => ({
  createQueryClient: mocks.createQueryClient,
}))
vi.mock("./community-query-persistence", () => ({
  COMMUNITY_QUERY_PERSIST_BUSTER: "community-v1",
  COMMUNITY_QUERY_PERSIST_MAX_AGE_MS: 86_400_000,
  createCommunityQueryPersister: mocks.createCommunityQueryPersister,
  shouldPersistQuery: mocks.shouldPersistQuery,
}))
vi.mock("@tanstack/react-query-persist-client", () => ({
  PersistQueryClientProvider: (props: Record<string, any>) => {
    mocks.providerProps = props
    return props.children
  },
}))
vi.mock("@tanstack/react-query-devtools", () => ({
  ReactQueryDevtools: () => null,
}))

import { CommunityQueryProvider } from "@/modules/community/client"

describe("CommunityQueryProvider", () => {
  beforeEach(() => {
    mocks.createQueryClient.mockReset().mockReturnValue(mocks.queryClient)
    mocks.createCommunityQueryPersister.mockReset().mockReturnValue(mocks.persister)
    mocks.shouldPersistQuery.mockReset().mockReturnValue(true)
    mocks.providerProps = null
  })

  it("composes generic mechanics with Community persistence policy", async () => {
    await act(async () => {
      TestRenderer.create(React.createElement(
        CommunityQueryProvider,
        { userId: "user-1" },
        React.createElement("span", null, "content"),
      ))
    })

    expect(mocks.createQueryClient).toHaveBeenCalledWith({
      persistedCacheMaxAgeMs: 86_400_000,
    })
    expect(mocks.createCommunityQueryPersister).toHaveBeenCalledWith("user-1")
    expect(mocks.providerProps).toMatchObject({
      client: mocks.queryClient,
      persistOptions: {
        persister: mocks.persister,
        maxAge: 86_400_000,
        buster: "community-v1",
      },
    })

    const shouldDehydrateQuery = mocks.providerProps?.persistOptions
      .dehydrateOptions.shouldDehydrateQuery as (query: Record<string, any>) => boolean
    expect(shouldDehydrateQuery({ state: { status: "pending" } })).toBe(false)
    expect(shouldDehydrateQuery({
      queryKey: ["community", "channel", "c1", "messages"],
      state: { status: "success", data: { pages: [] } },
    })).toBe(true)
    expect(mocks.shouldPersistQuery).toHaveBeenCalledOnce()
  })
})
