import { afterEach, describe, expect, it, vi } from "vitest"
import {
  LINK_PREVIEW_THUMBNAIL_LIMITS,
  LinkPreviewThumbnailFailure,
  fetchAndTransformLinkPreviewThumbnail,
  isFreshLinkPreviewThumbnailObject,
  linkPreviewPageDigest,
  linkPreviewThumbnailManifestKey,
  linkPreviewThumbnailNegativeKey,
  linkPreviewThumbnailObjectKey,
  linkPreviewThumbnailObjectMetadata,
  linkPreviewThumbnailUrl,
  normalizePublicImageUrl,
  readLinkPreviewThumbnailManifest,
  writeLinkPreviewThumbnailManifest,
  type LinkPreviewThumbnailManifest,
} from "./link-preview-thumbnail"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function bytesStream(bytes: Uint8Array, cancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
    cancel,
  })
}

function mockImages(args: {
  format?: string
  width?: number
  height?: number
  output?: Uint8Array
  outputType?: string
} = {}) {
  const transform = vi.fn()
  const output = vi.fn()
  const transformer = {
    transform: (...values: unknown[]) => {
      transform(...values)
      return transformer
    },
    output: async (...values: unknown[]) => {
      output(...values)
      const transformed = args.output ?? new Uint8Array([1, 2, 3])
      return {
        contentType: () => args.outputType ?? "image/webp",
        image: () => bytesStream(transformed),
        response: () => new Response(transformed),
      }
    },
  }
  const binding = {
    info: vi.fn().mockResolvedValue({
      format: args.format ?? "image/jpeg",
      fileSize: 3,
      width: args.width ?? 1200,
      height: args.height ?? 630,
    }),
    input: vi.fn(() => transformer),
  } as unknown as ImagesBinding
  return { binding, output, transform }
}

function response(body = new Uint8Array([0xff, 0xd8, 0xff]), init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { "content-type": "image/jpeg", ...init.headers },
  })
}

describe("link preview thumbnail addressing and manifests", () => {
  it("derives only fixed digest paths and keys", async () => {
    const digest = await linkPreviewPageDigest("https://example.com/")
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(linkPreviewThumbnailUrl(digest)).toBe(`/api/community/link-preview/thumbnail/${digest}`)
    expect(linkPreviewThumbnailManifestKey(digest)).toBe(`link-preview-thumbnails/v1/${digest}/manifest.json`)
    expect(linkPreviewThumbnailObjectKey(digest)).toBe(`link-preview-thumbnails/v1/${digest}/thumbnail.webp`)
    expect(linkPreviewThumbnailNegativeKey(digest, "b".repeat(64)))
      .toBe(`link-preview-thumbnail-negative:v1:${digest}:${"b".repeat(64)}`)
    expect(() => linkPreviewThumbnailUrl("../source")).toThrow("invalid thumbnail digest")
  })

  it("accepts only normalized public HTTPS image candidates", () => {
    expect(normalizePublicImageUrl("/og.png#private", new URL("https://example.com/post")).href)
      .toBe("https://example.com/og.png")
    expect(() => normalizePublicImageUrl("http://example.com/og.png")).toThrow("must use HTTPS")
    expect(() => normalizePublicImageUrl("https://127.0.0.1/og.png")).toThrow("non-public")
    expect(() => normalizePublicImageUrl("https://user:secret@example.com/og.png")).toThrow("authority")
    expect(() => normalizePublicImageUrl("https://example.com:8443/og.png")).toThrow("authority")
  })

  it("writes and reads one strongly-bound, expiring private manifest", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const pageDigest = "a".repeat(64)
    const manifest = await writeLinkPreviewThumbnailManifest({
      bucket: { put } as Pick<R2Bucket, "put">,
      pageDigest,
      sourceUrl: "https://images.example.com/og.png#fragment",
      now: 1_000,
    })
    expect(manifest).toMatchObject({
      version: 1,
      pageDigest,
      sourceUrl: "https://images.example.com/og.png",
      expiresAt: 1_000 + LINK_PREVIEW_THUMBNAIL_LIMITS.manifestTtlMs,
    })
    expect(manifest.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    const stored = put.mock.calls[0]?.[1] as string
    const object = {
      size: new TextEncoder().encode(stored).byteLength,
      body: bytesStream(new TextEncoder().encode(stored)),
      text: vi.fn().mockResolvedValue(stored),
    }
    await expect(readLinkPreviewThumbnailManifest({
      bucket: { get: vi.fn().mockResolvedValue(object) } as unknown as Pick<R2Bucket, "get">,
      pageDigest,
      now: 2_000,
    })).resolves.toEqual(manifest)
  })

  it("rejects invalid manifest writes and supports the default clock", async () => {
    await expect(writeLinkPreviewThumbnailManifest({
      bucket: { put: vi.fn() } as Pick<R2Bucket, "put">,
      pageDigest: "../source",
      sourceUrl: "https://example.com/image.jpg",
    })).rejects.toThrow("invalid thumbnail digest")

    const before = Date.now()
    const manifest = await writeLinkPreviewThumbnailManifest({
      bucket: { put: vi.fn().mockResolvedValue(undefined) } as Pick<R2Bucket, "put">,
      pageDigest: "a".repeat(64),
      sourceUrl: "https://example.com/image.jpg",
    })
    expect(manifest.expiresAt).toBeGreaterThanOrEqual(before + LINK_PREVIEW_THUMBNAIL_LIMITS.manifestTtlMs)
  })

  it.each([
    ["missing", null],
    ["oversized", { size: 4097, body: bytesStream(new Uint8Array([1])), text: vi.fn() }],
    ["malformed", { size: 1, body: bytesStream(new Uint8Array([1])), text: vi.fn().mockResolvedValue("{") }],
    ["mismatched", { size: 100, body: bytesStream(new Uint8Array([1])), text: vi.fn().mockResolvedValue(JSON.stringify({ version: 1, pageDigest: "b".repeat(64), sourceUrl: "https://example.com/a.jpg", sourceDigest: "c".repeat(64), expiresAt: 9_999 })) }],
    ["expired", { size: 100, body: bytesStream(new Uint8Array([1])), text: vi.fn().mockResolvedValue(JSON.stringify({ version: 1, pageDigest: "a".repeat(64), sourceUrl: "https://example.com/a.jpg", sourceDigest: "c".repeat(64), expiresAt: 1 })) }],
  ])("fails closed for a %s manifest", async (_label, object) => {
    await expect(readLinkPreviewThumbnailManifest({
      bucket: { get: vi.fn().mockResolvedValue(object) } as unknown as Pick<R2Bucket, "get">,
      pageDigest: "a".repeat(64),
      now: 2,
    })).resolves.toBeNull()
  })

  it("rejects invalid, non-record, and source-digest-mismatched manifests", async () => {
    const get = vi.fn()
    await expect(readLinkPreviewThumbnailManifest({
      bucket: { get } as unknown as Pick<R2Bucket, "get">,
      pageDigest: "../source",
    })).resolves.toBeNull()
    expect(get).not.toHaveBeenCalled()

    for (const stored of [
      "null",
      JSON.stringify({
        version: 1,
        pageDigest: "a".repeat(64),
        sourceUrl: "https://example.com/a.jpg",
        sourceDigest: "c".repeat(64),
        expiresAt: 9_999,
      }),
    ]) {
      await expect(readLinkPreviewThumbnailManifest({
        bucket: {
          get: vi.fn().mockResolvedValue({
            size: stored.length,
            body: bytesStream(new TextEncoder().encode(stored)),
            text: vi.fn().mockResolvedValue(stored),
          }),
        } as unknown as Pick<R2Bucket, "get">,
        pageDigest: "a".repeat(64),
        now: 1,
      })).resolves.toBeNull()
    }
  })

  it("swallows a failed oversized-manifest body cancellation", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("already closed"))
    await expect(readLinkPreviewThumbnailManifest({
      bucket: {
        get: vi.fn().mockResolvedValue({ size: 4097, body: { cancel } }),
      } as unknown as Pick<R2Bucket, "get">,
      pageDigest: "a".repeat(64),
    })).resolves.toBeNull()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("serves only a fresh WebP object matching the current source digest", () => {
    const manifest = { sourceDigest: "a".repeat(64) } as LinkPreviewThumbnailManifest
    const object = {
      size: 123,
      httpMetadata: { contentType: "image/webp" },
      customMetadata: { sourceDigest: "a".repeat(64), expiresAt: "2000" },
    } as unknown as R2ObjectBody
    expect(isFreshLinkPreviewThumbnailObject(object, manifest, 1_000)).toBe(true)
    expect(isFreshLinkPreviewThumbnailObject({ ...object, size: 512 * 1024 + 1 } as R2ObjectBody, manifest, 1_000)).toBe(false)
    expect(isFreshLinkPreviewThumbnailObject({ ...object, customMetadata: { ...object.customMetadata, sourceDigest: "b".repeat(64) } } as R2ObjectBody, manifest, 1_000)).toBe(false)
    expect(isFreshLinkPreviewThumbnailObject(object, manifest, 2_000)).toBe(false)
  })
})

describe("fetchAndTransformLinkPreviewThumbnail", () => {
  it.each([
    ["image/jpeg", "image/jpeg"],
    ["image/png", "image/png"],
    ["image/webp", "image/webp"],
  ])("accepts a bounded static %s and applies the one fixed profile", async (declared, decoded) => {
    const images = mockImages({ format: decoded })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": declared },
    })))

    await expect(fetchAndTransformLinkPreviewThumbnail("https://images.example.com/og", images.binding))
      .resolves.toEqual(new Uint8Array([1, 2, 3]))
    expect(images.transform).toHaveBeenCalledWith({ width: 640, height: 360, fit: "cover" })
    expect(images.output).toHaveBeenCalledWith({ format: "image/webp", quality: 78, anim: false })
  })

  it("follows at most three redirects, cancels them, and revalidates every HTTPS hop", async () => {
    const cancel = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel }), {
        status: 302,
        headers: { location: "https://cdn.example.com/second" },
      }))
      .mockResolvedValueOnce(response())
    vi.stubGlobal("fetch", fetchMock)

    await fetchAndTransformLinkPreviewThumbnail("https://images.example.com/start", mockImages().binding)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    })
  })

  it.each([
    ["HTTP downgrade", "http://example.com/image.jpg", "must use HTTPS"],
    ["private redirect", "https://127.0.0.1/image.jpg", "non-public"],
  ])("rejects a %s before the next fetch", async (_label, location, message) => {
    const cancel = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 302,
      headers: { location },
    }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchAndTransformLinkPreviewThumbnail("https://example.com/start", mockImages().binding))
      .rejects.toThrow(message)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects a missing redirect location and a fourth redirect, canceling every body", async () => {
    const missingCancel = vi.fn()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel: missingCancel }), { status: 302 })))
    await expect(fetchAndTransformLinkPreviewThumbnail("https://example.com/start", mockImages().binding))
      .rejects.toThrow("invalid thumbnail redirect")
    expect(missingCancel).toHaveBeenCalledOnce()

    const cancel = vi.fn()
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 302,
      headers: { location: "https://example.com/again" },
    })))
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchAndTransformLinkPreviewThumbnail("https://example.com/start", mockImages().binding))
      .rejects.toThrow("too many thumbnail redirects")
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(cancel).toHaveBeenCalledTimes(4)
  })

  it.each([
    ["bodyless", new Response(null, { headers: { "content-type": "image/jpeg" } }), "no body"],
    ["non-success", response(undefined, { status: 503 }), "rejected request"],
    ["missing MIME", new Response(new Uint8Array([1])), "unsupported thumbnail MIME"],
    ["wrong MIME", response(undefined, { headers: { "content-type": "image/gif" } }), "unsupported thumbnail MIME"],
    ["declared oversize", response(undefined, { headers: { "content-type": "image/jpeg", "content-length": String(5 * 1024 * 1024 + 1) } }), "too large"],
    ["unsafe declared length", response(undefined, { headers: { "content-type": "image/jpeg", "content-length": "9".repeat(400) } }), "too large"],
    ["empty body", response(new Uint8Array()), "empty"],
  ])("rejects a %s upstream response", async (_label, upstream, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstream))
    await expect(fetchAndTransformLinkPreviewThumbnail("https://example.com/image", mockImages().binding))
      .rejects.toThrow(message)
  })

  it("stream-counts and cancels an oversized body without content-length", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(LINK_PREVIEW_THUMBNAIL_LIMITS.maxSourceBytes + 1))
      },
      cancel,
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      headers: { "content-type": "image/jpeg" },
    })))

    await expect(fetchAndTransformLinkPreviewThumbnail("https://example.com/image", mockImages().binding))
      .rejects.toThrow("too large")
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([
    ["SVG", "image/svg+xml", 100, 100, "image/jpeg"],
    ["GIF", "image/gif", 100, 100, "image/jpeg"],
    ["MIME mismatch", "image/png", 100, 100, "image/jpeg"],
    ["oversized side", "image/jpeg", 8193, 1, "image/jpeg"],
    ["oversized area", "image/jpeg", 8000, 2001, "image/jpeg"],
  ])("rejects decoded %s before transformation", async (_label, format, width, height, declared) => {
    const images = mockImages({ format, width, height })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(undefined, {
      headers: { "content-type": declared },
    })))

    await expect(fetchAndTransformLinkPreviewThumbnail("https://example.com/image", images.binding)).rejects.toThrow()
    expect(images.transform).not.toHaveBeenCalled()
  })

  it("rejects APNG and animated WebP before transformation", async () => {
    const apng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 0, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 0,
    ])
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(apng, { headers: { "content-type": "image/png" } })))
    await expect(fetchAndTransformLinkPreviewThumbnail("https://example.com/apng", mockImages({ format: "image/png" }).binding))
      .rejects.toThrow("animated thumbnail")

    const animatedWebp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58, 1, 0, 0, 0, 0x02, 0,
    ])
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(animatedWebp, { headers: { "content-type": "image/webp" } })))
    await expect(fetchAndTransformLinkPreviewThumbnail("https://example.com/animated", mockImages({ format: "image/webp" }).binding))
      .rejects.toThrow("animated thumbnail")

    const animChunkWebp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x41, 0x4e, 0x49, 0x4d, 0, 0, 0, 0,
    ])
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(animChunkWebp, { headers: { "content-type": "image/webp" } })))
    await expect(fetchAndTransformLinkPreviewThumbnail("https://example.com/anim-chunk", mockImages({ format: "image/webp" }).binding))
      .rejects.toThrow("animated thumbnail")
  })

  it.each([
    [
      "a malformed PNG chunk",
      "image/png",
      new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 20, 0x74, 0x45, 0x58, 0x74, 0, 0, 0, 0,
      ]),
    ],
    [
      "a malformed WebP chunk",
      "image/webp",
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        0x56, 0x50, 0x38, 0x20, 20, 0, 0, 0,
      ]),
    ],
  ])("fails safely while scanning %s", async (_label, mime, bytes) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(bytes, {
      headers: { "content-type": mime },
    })))

    await expect(fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/static",
      mockImages({ format: mime }).binding,
    )).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it.each([
    [
      "a static PNG ending at IDAT",
      "image/png",
      new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0,
      ]),
    ],
    [
      "a static PNG with only an ancillary chunk",
      "image/png",
      new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 0, 0x74, 0x45, 0x58, 0x74, 0, 0, 0, 0,
      ]),
    ],
    [
      "a static WebP chunk",
      "image/webp",
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0,
      ]),
    ],
  ])("accepts %s as non-animated", async (_label, mime, bytes) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(bytes, {
      headers: { "content-type": mime },
    })))

    await expect(fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/static",
      mockImages({ format: mime }).binding,
    )).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it("rejects a wrong or oversized transformed output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(response())))
    await expect(fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/image",
      mockImages({ outputType: "image/png" }).binding,
    )).rejects.toMatchObject({
      stage: "transform",
      disposition: "deterministic",
      code: "transform_mime",
      message: "thumbnail transform returned wrong MIME",
    })

    await expect(fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/image",
      mockImages({ output: new Uint8Array(LINK_PREVIEW_THUMBNAIL_LIMITS.maxOutputBytes + 1) }).binding,
    )).rejects.toMatchObject({
      stage: "transform",
      disposition: "deterministic",
      code: "transform_size",
      message: "thumbnail response is too large",
    })
  })

  it("rejects decoded image info without raster dimensions", async () => {
    const images = mockImages()
    vi.mocked(images.binding.info).mockResolvedValue({
      format: "image/svg+xml",
      fileSize: 3,
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()))

    await expect(fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/image",
      images.binding,
    )).rejects.toThrow("unsupported decoded thumbnail format")
  })

  it("applies the three-second budget across a stalled source read", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => Promise.resolve(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true })
        },
      }),
      { headers: { "content-type": "image/jpeg" } },
    ))))

    const result = fetchAndTransformLinkPreviewThumbnail("https://example.com/slow", mockImages().binding)
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_THUMBNAIL_LIMITS.sourceTimeoutMs)
    await expect(result).resolves.toMatchObject({
      stage: "source",
      disposition: "transient",
      code: "source_timeout",
    })
  })

  it("rejects before reading when source headers resolve after the source budget", async () => {
    vi.useFakeTimers()
    let resolveFetch!: (response: Response) => void
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })))

    const result = fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/late-headers",
      mockImages().binding,
    )
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_THUMBNAIL_LIMITS.sourceTimeoutMs)
    resolveFetch(response())

    await expect(result).rejects.toMatchObject({
      stage: "source",
      disposition: "transient",
      code: "source_timeout",
    })
  })

  it("clears the source deadline before a valid Images operation uses its own five-second budget", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(response()), LINK_PREVIEW_THUMBNAIL_LIMITS.sourceTimeoutMs - 100)
    })))
    const images = mockImages()
    vi.mocked(images.binding.info).mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ format: "image/jpeg", fileSize: 3, width: 1200, height: 630 }), 4_000)
    }))

    const result = fetchAndTransformLinkPreviewThumbnail("https://example.com/slow-valid", images.binding)
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_THUMBNAIL_LIMITS.sourceTimeoutMs - 100)
    await vi.advanceTimersByTimeAsync(4_000)

    await expect(result).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it("bounds Images at five seconds and observes a late platform rejection", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()))
    const images = mockImages()
    vi.mocked(images.binding.info).mockImplementation(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(Object.assign(new Error("late"), { code: 9523 })), 6_000)
    }))

    const result = fetchAndTransformLinkPreviewThumbnail("https://example.com/slow-images", images.binding)
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_THUMBNAIL_LIMITS.imagesTimeoutMs)
    await expect(result).resolves.toMatchObject({
      stage: "inspect",
      disposition: "transient",
      code: "inspect_timeout",
    })
    await vi.advanceTimersByTimeAsync(1_000)
  })

  it("classifies deterministic input rejection and transient service failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(undefined, {
      headers: { "content-type": "image/gif" },
    })))
    await expect(fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/wrong-mime",
      mockImages().binding,
    )).rejects.toMatchObject({
      stage: "source",
      disposition: "deterministic",
      code: "source_mime",
    } satisfies Partial<LinkPreviewThumbnailFailure>)

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(undefined, { status: 503 })))
    await expect(fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/unavailable",
      mockImages().binding,
    )).rejects.toMatchObject({
      stage: "source",
      disposition: "transient",
      code: "source_http_503",
    } satisfies Partial<LinkPreviewThumbnailFailure>)

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(undefined, { status: 429 })))
    await expect(fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/rate-limited",
      mockImages().binding,
    )).rejects.toMatchObject({
      stage: "source",
      disposition: "transient",
      code: "source_http_429",
    } satisfies Partial<LinkPreviewThumbnailFailure>)

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")))
    await expect(fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/aborted",
      mockImages().binding,
    )).rejects.toMatchObject({
      stage: "source",
      disposition: "transient",
      code: "source_aborted",
    } satisfies Partial<LinkPreviewThumbnailFailure>)

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("unknown"))
    await expect(fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/unknown",
      mockImages().binding,
    )).rejects.toMatchObject({
      stage: "source",
      disposition: "transient",
      code: "source_error",
    } satisfies Partial<LinkPreviewThumbnailFailure>)

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()))
    const images = mockImages()
    vi.mocked(images.binding.info).mockRejectedValue(Object.assign(new Error("service"), { code: 9523 }))
    await expect(fetchAndTransformLinkPreviewThumbnail(
      "https://example.com/images-error",
      images.binding,
    )).rejects.toMatchObject({
      stage: "inspect",
      disposition: "transient",
      code: "inspect_9523",
    } satisfies Partial<LinkPreviewThumbnailFailure>)
  })

  it("builds exact 24-hour R2 object metadata", () => {
    const manifest = { sourceDigest: "a".repeat(64) } as LinkPreviewThumbnailManifest
    expect(linkPreviewThumbnailObjectMetadata(manifest, 1_000)).toEqual({
      httpMetadata: {
        contentType: "image/webp",
        cacheControl: "private, max-age=21600, immutable",
        contentDisposition: "inline",
      },
      customMetadata: {
        sourceDigest: "a".repeat(64),
        expiresAt: String(1_000 + LINK_PREVIEW_THUMBNAIL_LIMITS.thumbnailTtlMs),
      },
    })
  })
})
