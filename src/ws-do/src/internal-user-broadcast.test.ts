import { describe, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, deriveCommunityDeliveryOperationId, prepareCommunityDeliveryEvents } from "@alook/shared"
import { createInternalCommunityUserBundleRequest, getInternalCommunityUserTarget } from "./internal-user-broadcast"
import { readCommunityBrowserEventBundleRequest } from "./community-browser-event-ingress"

describe("internal current community bundle request", () => {
  it("keeps the target and current operation bytes intact and refuses an old consumer contract", async () => {
    const events = [{ type: "community:presence.update", userId: "peer", online: true }]
    const prepared = await prepareCommunityDeliveryEvents(events)
    if (!prepared.ok) throw new Error("invalid fixture")
    const id = await deriveCommunityDeliveryOperationId("message")
    const request = createInternalCommunityUserBundleRequest("viewer/你好", id, prepared.prepared.digest, prepared.prepared.envelopes)
    expect(request.url).toBe("http://internal/community-broadcast-bundle")
    expect(request.method).toBe("POST")
    expect(request.headers.get("content-type")).toBe("application/json")
    expect(request.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    expect(getInternalCommunityUserTarget(request)).toBe("viewer/你好")
    expect(await request.clone().json()).toEqual({ operationId: id, operationDigest: prepared.prepared.digest, events: prepared.prepared.envelopes, communityContract: BUSINESS_SCHEMA_VERSION })
    expect(await readCommunityBrowserEventBundleRequest(request)).toMatchObject({ ok: true })
    const old = createInternalCommunityUserBundleRequest("viewer", id, prepared.prepared.digest, prepared.prepared.envelopes, 3 as never)
    expect(await readCommunityBrowserEventBundleRequest(old)).toMatchObject({ ok: false })
  })
})
