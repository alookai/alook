import { normalizePublicPreviewUrl } from "./link-preview-fetch"

const THUMBNAIL_VERSION = 1
const THUMBNAIL_PREFIX = "link-preview-thumbnails/v1"
const MAX_SOURCE_BYTES = 5 * 1024 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_MANIFEST_BYTES = 4 * 1024
const MAX_REDIRECTS = 3
const TOTAL_TIMEOUT_MS = 3_000
const MAX_DIMENSION = 8_192
const MAX_AREA = 16_000_000
const THUMBNAIL_WIDTH = 640
const THUMBNAIL_HEIGHT = 360
const THUMBNAIL_QUALITY = 78
const MANIFEST_TTL_MS = 6 * 60 * 60 * 1_000
const THUMBNAIL_TTL_MS = 24 * 60 * 60 * 1_000
const TOKEN_RE = /^[a-f0-9]{64}$/
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"])

export type LinkPreviewThumbnailManifest = {
  version: 1
  pageDigest: string
  sourceUrl: string
  sourceDigest: string
  expiresAt: number
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function linkPreviewPageDigest(canonicalPageUrl: string): Promise<string> {
  return sha256Hex(canonicalPageUrl)
}

export function linkPreviewThumbnailUrl(pageDigest: string): string {
  if (!TOKEN_RE.test(pageDigest)) throw new Error("invalid thumbnail digest")
  return `/api/community/link-preview/thumbnail/${pageDigest}`
}

export function linkPreviewThumbnailManifestKey(pageDigest: string): string {
  return `${THUMBNAIL_PREFIX}/${pageDigest}/manifest.json`
}

export function linkPreviewThumbnailObjectKey(pageDigest: string): string {
  return `${THUMBNAIL_PREFIX}/${pageDigest}/thumbnail.webp`
}

export function linkPreviewThumbnailNegativeKey(pageDigest: string, sourceDigest: string): string {
  return `link-preview-thumbnail-negative:v1:${pageDigest}:${sourceDigest}`
}

export function isLinkPreviewThumbnailDigest(value: string | undefined): value is string {
  return typeof value === "string" && TOKEN_RE.test(value)
}

export function normalizePublicImageUrl(input: string, base?: URL): URL {
  const resolved = base ? new URL(input, base) : new URL(input)
  const normalized = normalizePublicPreviewUrl(resolved.href)
  if (normalized.protocol !== "https:") throw new Error("thumbnail source must use HTTPS")
  return normalized
}

export async function writeLinkPreviewThumbnailManifest(args: {
  bucket: Pick<R2Bucket, "put">
  pageDigest: string
  sourceUrl: string
  now?: number
}): Promise<LinkPreviewThumbnailManifest> {
  if (!isLinkPreviewThumbnailDigest(args.pageDigest)) throw new Error("invalid thumbnail digest")
  const sourceUrl = normalizePublicImageUrl(args.sourceUrl).href
  const now = args.now ?? Date.now()
  const manifest: LinkPreviewThumbnailManifest = {
    version: THUMBNAIL_VERSION,
    pageDigest: args.pageDigest,
    sourceUrl,
    sourceDigest: await sha256Hex(sourceUrl),
    expiresAt: now + MANIFEST_TTL_MS,
  }
  await args.bucket.put(
    linkPreviewThumbnailManifestKey(args.pageDigest),
    JSON.stringify(manifest),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        version: String(THUMBNAIL_VERSION),
        pageDigest: args.pageDigest,
        sourceDigest: manifest.sourceDigest,
        expiresAt: String(manifest.expiresAt),
      },
    },
  )
  return manifest
}

function manifestRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export async function readLinkPreviewThumbnailManifest(args: {
  bucket: Pick<R2Bucket, "get">
  pageDigest: string
  now?: number
}): Promise<LinkPreviewThumbnailManifest | null> {
  if (!isLinkPreviewThumbnailDigest(args.pageDigest)) return null
  const object = await args.bucket.get(linkPreviewThumbnailManifestKey(args.pageDigest))
  if (!object) return null
  if (object.size <= 0 || object.size > MAX_MANIFEST_BYTES) {
    await object.body.cancel().catch(() => {})
    return null
  }
  try {
    const record = manifestRecord(JSON.parse(await object.text()))
    if (!record
      || record.version !== THUMBNAIL_VERSION
      || record.pageDigest !== args.pageDigest
      || typeof record.sourceUrl !== "string"
      || typeof record.sourceDigest !== "string"
      || !TOKEN_RE.test(record.sourceDigest)
      || typeof record.expiresAt !== "number"
      || !Number.isSafeInteger(record.expiresAt)
      || record.expiresAt <= (args.now ?? Date.now())) {
      return null
    }
    const sourceUrl = normalizePublicImageUrl(record.sourceUrl).href
    if (await sha256Hex(sourceUrl) !== record.sourceDigest) return null
    return {
      version: THUMBNAIL_VERSION,
      pageDigest: args.pageDigest,
      sourceUrl,
      sourceDigest: record.sourceDigest,
      expiresAt: record.expiresAt,
    }
  } catch {
    return null
  }
}

export function isFreshLinkPreviewThumbnailObject(
  object: R2ObjectBody,
  manifest: LinkPreviewThumbnailManifest,
  now = Date.now(),
): boolean {
  const expiresAt = Number(object.customMetadata?.expiresAt)
  return object.size > 0
    && object.size <= MAX_OUTPUT_BYTES
    && object.httpMetadata?.contentType === "image/webp"
    && object.customMetadata?.sourceDigest === manifest.sourceDigest
    && Number.isSafeInteger(expiresAt)
    && expiresAt > now
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function abortError(): Error {
  return new DOMException("thumbnail request timed out", "AbortError")
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError()
  let rejectAbort!: (reason?: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(abortError())
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!body) throw new Error("thumbnail response has no body")
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal)
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error("thumbnail response is too large")
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new Error("thumbnail response is empty")
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function declaredContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length")
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY
}

async function fetchThumbnailSource(start: URL, signal: AbortSignal): Promise<{
  bytes: Uint8Array
  contentType: string
}> {
  let current = start
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(current.href, {
      method: "GET",
      redirect: "manual",
      signal,
      credentials: "omit",
      headers: {
        Accept: "image/jpeg,image/png,image/webp",
        "User-Agent": "Alook-Link-Preview-Thumbnail/1.0",
      },
      referrerPolicy: "no-referrer",
    })
    if (isRedirect(response.status)) {
      await response.body?.cancel().catch(() => {})
      if (redirects === MAX_REDIRECTS) throw new Error("too many thumbnail redirects")
      const location = response.headers.get("location")
      if (!location) throw new Error("invalid thumbnail redirect")
      current = normalizePublicImageUrl(location, current)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error("thumbnail origin rejected request")
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
    if (!ALLOWED_MIME.has(contentType)) {
      await response.body?.cancel().catch(() => {})
      throw new Error("unsupported thumbnail MIME")
    }
    if ((declaredContentLength(response) ?? 0) > MAX_SOURCE_BYTES) {
      await response.body?.cancel().catch(() => {})
      throw new Error("thumbnail response is too large")
    }
    return {
      bytes: await readBoundedBytes(response.body, MAX_SOURCE_BYTES, signal),
      contentType,
    }
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function isAnimatedPng(bytes: Uint8Array): boolean {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 8 || pngSignature.some((byte, index) => bytes[index] !== byte)) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const end = offset + 12 + length
    if (end > bytes.length) return false
    const type = ascii(bytes, offset + 4, 4)
    if (type === "acTL") return true
    if (type === "IDAT" || type === "IEND") return false
    offset = end
  }
  return false
}

function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4)
    const length = view.getUint32(offset + 4, true)
    const dataStart = offset + 8
    const end = dataStart + length
    if (end > bytes.length) return false
    if (type === "ANIM" || type === "ANMF") return true
    if (type === "VP8X" && length >= 1 && (bytes[dataStart]! & 0x02) !== 0) return true
    offset = end + (length % 2)
  }
  return false
}

function decodedMime(format: string): string | null {
  const normalized = format.toLowerCase()
  if (normalized === "image/jpeg" || normalized === "jpeg" || normalized === "jpg") return "image/jpeg"
  if (normalized === "image/png" || normalized === "png") return "image/png"
  if (normalized === "image/webp" || normalized === "webp") return "image/webp"
  return null
}

async function transformThumbnail(
  images: ImagesBinding,
  bytes: Uint8Array,
  declaredMime: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const info = await withAbort(images.info(streamFromBytes(bytes)), signal)
  if (!("width" in info) || !("height" in info)) throw new Error("unsupported decoded thumbnail format")
  const actualMime = decodedMime(info.format)
  if (!actualMime || actualMime !== declaredMime) throw new Error("thumbnail MIME mismatch")
  if (actualMime === "image/png" && isAnimatedPng(bytes)) throw new Error("animated thumbnail rejected")
  if (actualMime === "image/webp" && isAnimatedWebp(bytes)) throw new Error("animated thumbnail rejected")
  if (!Number.isSafeInteger(info.width)
    || !Number.isSafeInteger(info.height)
    || info.width <= 0
    || info.height <= 0
    || info.width > MAX_DIMENSION
    || info.height > MAX_DIMENSION
    || info.width * info.height > MAX_AREA) {
    throw new Error("thumbnail dimensions exceed limit")
  }

  const output = await withAbort(images
    .input(streamFromBytes(bytes))
    .transform({ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, fit: "cover" })
    .output({ format: "image/webp", quality: THUMBNAIL_QUALITY, anim: false }), signal)
  if (output.contentType() !== "image/webp") throw new Error("thumbnail transform returned wrong MIME")
  return readBoundedBytes(output.image(), MAX_OUTPUT_BYTES, signal)
}

export async function fetchAndTransformLinkPreviewThumbnail(
  sourceUrl: string,
  images: ImagesBinding,
): Promise<Uint8Array> {
  const source = normalizePublicImageUrl(sourceUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  try {
    const fetched = await fetchThumbnailSource(source, controller.signal)
    return await transformThumbnail(images, fetched.bytes, fetched.contentType, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export function linkPreviewThumbnailObjectMetadata(manifest: LinkPreviewThumbnailManifest, now = Date.now()) {
  return {
    httpMetadata: {
      contentType: "image/webp",
      cacheControl: "private, max-age=21600, immutable",
      contentDisposition: "inline",
    },
    customMetadata: {
      sourceDigest: manifest.sourceDigest,
      expiresAt: String(now + THUMBNAIL_TTL_MS),
    },
  } satisfies R2PutOptions
}

export const LINK_PREVIEW_THUMBNAIL_LIMITS = {
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxRedirects: MAX_REDIRECTS,
  timeoutMs: TOTAL_TIMEOUT_MS,
  maxDimension: MAX_DIMENSION,
  maxArea: MAX_AREA,
  width: THUMBNAIL_WIDTH,
  height: THUMBNAIL_HEIGHT,
  quality: THUMBNAIL_QUALITY,
  manifestTtlMs: MANIFEST_TTL_MS,
  thumbnailTtlMs: THUMBNAIL_TTL_MS,
  prefix: THUMBNAIL_PREFIX,
} as const
