import { describe, expect, it } from "vitest"
import { createInternalCommunityUserBundleRequest, getInternalCommunityUserTarget } from "./internal-user-broadcast"

describe("internal community bundle request", () => {
  it("defaults to the legacy contract while keeping the target and operation intact", async () => {
    const events = [{ type: "community:presence.update", userId: "peer", online: true }]
    const request = createInternalCommunityUserBundleRequest("viewer/你好", "operation", "digest", events)
    expect(request.url).toBe("http://internal/community-broadcast-bundle")
    expect(request.method).toBe("POST")
    expect(request.headers.get("content-type")).toBe("application/json")
    expect(getInternalCommunityUserTarget(request)).toBe("viewer/你好")
    expect(await request.json()).toEqual({ operationId: "operation", operationDigest: "digest", events })
    expect(await createInternalCommunityUserBundleRequest("viewer", "operation", "digest", events, 3).json())
      .toEqual({ operationId: "operation", operationDigest: "digest", events, communityContract: 3 })
  })
})
