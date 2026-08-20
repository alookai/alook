import { describe, expect, it } from "vitest"
import { createQueryClient } from "./query-client"

describe("createQueryClient", () => {
  it("uses the product-supplied persistence lifetime for query GC", () => {
    const client = createQueryClient({ persistedCacheMaxAgeMs: 86_400_000 })

    expect(client.getDefaultOptions().queries).toMatchObject({
      staleTime: 5_000,
      gcTime: 86_400_000,
      refetchOnWindowFocus: false,
      retry: 1,
    })
  })

  it("creates an isolated client for each owner", () => {
    const first = createQueryClient({ persistedCacheMaxAgeMs: 1 })
    const second = createQueryClient({ persistedCacheMaxAgeMs: 1 })

    expect(first).not.toBe(second)
  })
})
