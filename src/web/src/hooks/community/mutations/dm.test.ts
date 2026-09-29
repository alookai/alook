import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { dmsResourceKey } from "@/lib/community-db/dms-resource"

const apiFetch = vi.fn()
const useMutation = vi.fn((options) => options)
let queryClient: QueryClient

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => queryClient,
    useMutation: (options: unknown) => useMutation(options),
  }
})

import { useCreateOrGetDm } from "./dm"

describe("useCreateOrGetDm", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient()
  })

  it("creates through the unified channel door and invalidates only DM resources", async () => {
    const options = useCreateOrGetDm() as any
    apiFetch.mockResolvedValue({ conversation: { id: "dm-1" } })

    await expect(options.mutationFn({ userId: "peer-1" }))
      .resolves.toEqual({ conversation: { id: "dm-1" } })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined as never)
    options.onSuccess()

    expect(apiFetch).toHaveBeenCalledWith("/api/community/channels", {
      method: "POST",
      body: JSON.stringify({ type: "dm", userId: "peer-1" }),
    })
    const filters = invalidate.mock.calls[0]?.[0]
    expect(filters?.predicate?.({ queryKey: dmsResourceKey("viewer") } as never)).toBe(true)
    expect(filters?.predicate?.({ queryKey: ["community", "other"] } as never)).toBe(false)
  })
})
