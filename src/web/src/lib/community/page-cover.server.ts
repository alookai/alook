import { PAGE_COVER_MAX_BYTES } from "@alook/shared"

export const pageCoverKey = (id: string) => `page-covers/${id}`

export async function readPageCoverBody(request: Request) {
  const declared = Number(request.headers.get("content-length"))
  if (declared > PAGE_COVER_MAX_BYTES) return { ok: false as const, status: 413 }
  const reader = request.body?.getReader()
  if (!reader) return { ok: false as const, status: 400 }
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > PAGE_COVER_MAX_BYTES) {
        await reader.cancel().catch(() => {})
        return { ok: false as const, status: 413 }
      }
      chunks.push(value)
    }
  } catch { return { ok: false as const, status: 400 } }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return { ok: true as const, bytes }
}
