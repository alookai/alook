import { beforeEach, describe, expect, it } from "vitest"
import { CloudflareProvider, ProviderError } from "../src/cloudflare"
import { artifact, config } from "./fixtures"

const control = "https://pages-native-control.invalid/requests"
const provider = () => new CloudflareProvider(config, "native-test-placeholder")
const counts = async () => (await fetch(control)).json<{ requests: { method: string; path: string }[]; redirectedRequests: number }>()

beforeEach(async () => { await (await fetch(control, { method: "POST" })).body?.cancel() })

describe("native provider fetch boundary", () => {
  it("passes real workerd fetch argument validation before reaching the provider", async () => {
    let result: unknown
    let failure: string | undefined
    try { result = await provider().inspect("native-roundtrip") } catch (error) { failure = error instanceof ProviderError ? error.code : "unexpected_error" }
    const observed = await counts()
    expect({ failure, result, providerRequests: observed.requests.length }).toEqual({ failure: undefined, result: { tags: [] }, providerRequests: 1 })
    expect(observed.redirectedRequests).toBe(0)
  })
  it("sends the actual native GET, asset POSTs, PUT and DELETE requests", async () => {
    const api = provider()
    const value = await artifact()
    const release = { target: "native-roundtrip", operationId: "native-op", digest: value.digest }
    expect(await api.inspect(release.target)).toEqual({ tags: [] })
    const jwt = await api.assets(release.target, value)
    expect(jwt).toBe("native-completion")
    await api.publish(release.target, value, release, "native-page", jwt)
    await api.destroy(release.target)
    const observed = await counts()
    expect(observed.requests.map(request => request.method)).toEqual(["GET", "POST", "POST", "PUT", "DELETE"])
    expect(observed.requests[1].path).toContain("/assets-upload-session")
    expect(observed.requests[2].path).toBe(`/client/v4/accounts/${config.account}/workers/assets/upload`)
    expect(observed.redirectedRequests).toBe(0)
  })
  it("rejects native GET redirects without following their destination", async () => {
    await expect(provider().inspect("native-redirect")).rejects.toMatchObject({ code: "provider_http_302", uncertain: false })
    expect(await counts()).toMatchObject({ requests: [{ method: "GET" }], redirectedRequests: 0 })
  })
  it("keeps a native PUT redirect uncertain without following it", async () => {
    const value = await artifact()
    await expect(provider().publish("native-redirect", value, { target: "native-redirect", operationId: "op", digest: value.digest }, "page"))
      .rejects.toMatchObject({ code: "provider_http_302", uncertain: true })
    expect(await counts()).toMatchObject({ requests: [{ method: "PUT" }], redirectedRequests: 0 })
  })
})
