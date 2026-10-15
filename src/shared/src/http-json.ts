export type BoundedHttpJsonFailure = { ok: false; reason: "oversized" | "invalid-json"; byteCount: number }
export type BoundedHttpJsonResult = { ok: true; value: unknown; byteCount: number } | BoundedHttpJsonFailure

function oversized(byteCount: number): BoundedHttpJsonFailure {
  return { ok: false, reason: "oversized", byteCount }
}

export async function readBoundedJsonRequest(
  request: Request,
  maxBytes: number,
): Promise<BoundedHttpJsonResult> {
  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (Number.isSafeInteger(declared) && declared > maxBytes) return oversized(declared)
  }
  const reader = request.body?.getReader()
  if (!reader) return { ok: false, reason: "invalid-json", byteCount: 0 }
  const chunks: Uint8Array[] = []
  let byteCount = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteCount += value.byteLength
      if (byteCount > maxBytes) {
        try {
          await reader.cancel()
        } catch {}
        return oversized(byteCount)
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: "invalid-json", byteCount }
  }
  const bytes = new Uint8Array(byteCount)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return { ok: false, reason: "invalid-json", byteCount }
  }
  try {
    return { ok: true, value: JSON.parse(text), byteCount }
  } catch {
    return { ok: false, reason: "invalid-json", byteCount }
  }
}
