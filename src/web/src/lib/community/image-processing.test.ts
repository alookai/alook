import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommunityImageResponse, ImageProcessingError, MAX_IMAGE_PROCESSING_BYTES } from "./image-processing"

const work = vi.hoisted(() => [] as Promise<unknown>[])
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: async () => ({ ctx: { waitUntil: (promise: Promise<unknown>) => work.push(promise) } }) }))

function source(etag = '"original-a"', size = 5) {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("input")); controller.close() }, cancel })
  return { value: { body, size, httpEtag: etag } as R2ObjectBody, cancel }
}

function binding() {
  const transform = vi.fn()
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => ({
    transform(options: unknown) {
      transform(options)
      return { output: async () => {
        await new Response(stream).arrayBuffer()
        return { response: (options?: { headers?: HeadersInit }) => new Response("derived", { headers: { "Content-Type": "image/webp", ...Object.fromEntries(new Headers(options?.headers)) } }) }
      } }
    },
  }))
  return { env: { IMAGES: { input } } as unknown as Env, input, transform }
}

describe("authorized image representations", () => {
  const entries = new Map<string, Response>()
  const match = vi.fn(async (key: Request) => entries.get(key.url)?.clone())
  const put = vi.fn(async (key: Request, response: Response) => { entries.set(key.url, new Response(await response.arrayBuffer(), response)) })
  const request = new Request("https://alook.test/api/community/channels/c/attachments/a/thumbnail?image=1")
  beforeEach(() => {
    vi.clearAllMocks(); entries.clear(); work.length = 0
    vi.stubGlobal("caches", { open: async () => ({ match, put }) })
  })
  afterEach(async () => { await Promise.all(work); vi.unstubAllGlobals() })

  it("keeps browser responses private and reuses successful derived bytes behind the caller's authorization", async () => {
    const { env, input } = binding()
    const args = { request, env, sourceKey: "original", variant: "attachment" as const, cacheControl: "private, max-age=31536000, immutable" }
    const first = await createCommunityImageResponse({ ...args, source: source().value })
    expect(await first.text()).toBe("derived")
    expect(first.headers.get("Content-Type")).toBe("image/webp")
    expect(first.headers.get("Cache-Control")).toBe(args.cacheControl)
    expect(first.headers.get("X-Content-Type-Options")).toBe("nosniff")
    await Promise.all(work)
    const second = await createCommunityImageResponse({ ...args, source: source().value })
    expect(await second.text()).toBe("derived")
    expect(second.headers.get("Cache-Control")).toBe(args.cacheControl)
    expect(input).toHaveBeenCalledOnce()
    expect(put).toHaveBeenCalledOnce()
    expect([...entries.keys()][0]).toMatch(/^https:\/\/alook.test\/__private-community-images\/1\/[a-f0-9]{64}$/)
  })

  it("binds cache entries and validators to the source version and display variant", async () => {
    const { env, input } = binding()
    const args = { request, env, sourceKey: "same-key", variant: "attachment" as const, cacheControl: "private" }
    const a = await createCommunityImageResponse({ ...args, source: source().value }); await a.text(); await Promise.all(work)
    const b = await createCommunityImageResponse({ ...args, source: source('"original-b"').value }); await b.text(); await Promise.all(work)
    const c = await createCommunityImageResponse({ ...args, source: source().value, variant: "preview" }); await c.text()
    expect(new Set([a, b, c].map(response => response.headers.get("ETag"))).size).toBe(3)
    expect(input).toHaveBeenCalledTimes(3)
    const conditional = await createCommunityImageResponse({ ...args, source: source().value,
      request: new Request(request, { headers: { "If-None-Match": a.headers.get("ETag")! } }) })
    expect(conditional.status).toBe(304)
    expect(await conditional.text()).toBe("")
    expect(input).toHaveBeenCalledTimes(3)
  })

  it("does not transform or cache an existing oversized original", async () => {
    const { env, input } = binding()
    await expect(createCommunityImageResponse({ request, env, source: source(undefined, MAX_IMAGE_PROCESSING_BYTES + 1).value,
      sourceKey: "large", variant: "attachment", cacheControl: "private" })).rejects.toMatchObject({ reason: "too_large" })
    expect(input).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it("leaves processing failures retryable without returning or caching original bytes", async () => {
    const { env, input } = binding()
    input.mockImplementationOnce(() => { throw new Error("decode rejected") })
    const args = { request, env, sourceKey: "original", variant: "attachment" as const, cacheControl: "private" }
    await expect(createCommunityImageResponse({ ...args, source: source().value })).rejects.toBeInstanceOf(ImageProcessingError)
    expect(put).not.toHaveBeenCalled()
    const retry = await createCommunityImageResponse({ ...args, source: source().value })
    expect(await retry.text()).toBe("derived")
    expect(input).toHaveBeenCalledTimes(2)
  })

  it("serves the successful transform if the optional cache cannot be read or written", async () => {
    const { env } = binding()
    match.mockRejectedValueOnce(new Error("cache read")); put.mockRejectedValueOnce(new Error("cache write"))
    const response = await createCommunityImageResponse({ request, env, source: source().value, sourceKey: "original", variant: "identity", cacheControl: "private" })
    expect(await response.text()).toBe("derived")
    await Promise.all(work)
  })
})
