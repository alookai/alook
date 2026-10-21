export const LIMITS = {
  requestBytes: 1024 * 1024,
  indexBytes: 1536 * 1024,
  recordsPerRequest: 2000,
  retainedBytes: 64 * 1024 * 1024,
  retainedBatches: 200,
  retainedRecords: 50_000,
  traceSpans: 5000,
  traceBytes: 8 * 1024 * 1024,
  listRows: 100,
} as const

export class InputError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export async function readBody(request: Request) {
  const declared = request.headers.get("content-length")
  if (declared && Number(declared) > LIMITS.requestBytes) throw new InputError("Request exceeds 1 MiB", 413)
  const reader = request.body?.getReader()
  if (!reader) throw new InputError("JSON body is required")
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > LIMITS.requestBytes) {
        await reader.cancel()
        throw new InputError("Request exceeds 1 MiB", 413)
      }
      chunks.push(decoder.decode(next.value, { stream: true }))
    }
    chunks.push(decoder.decode())
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError("Body must be valid UTF-8")
  } finally { reader.releaseLock() }
  return { raw: chunks.join(""), bytes }
}
