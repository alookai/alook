import { isTauri, tauriInvoke } from "@alook/shared"

export const FILE_SAVE_CHUNK_BYTES = 65_536
export type FileSaveResult =
  | { status: "started"; destination?: "share" }
  | { status: "saved"; name: string; mime: string; bytes: number; sha256: string; destination: string }
  | { status: "cancelled" }
  | { status: "error"; message: string }

type FileSource = { name: string; mime: string; size: number | null; stream: ReadableStream<Uint8Array> }
type NativeReceipt = { attemptId: string; status: string; name: string; mime: string; bytes: number; sha256: string; destination: string }

export function fileSaveMessage(result: FileSaveResult): string | null {
  if (result.status === "saved") return "Saved"
  if (result.status === "started") return result.destination === "share" ? "Share sheet opened" : "Download started"
  if (result.status === "error") return "Couldn’t save — retry"
  return null
}

function normalizedError(error: unknown): FileSaveResult {
  if (error instanceof DOMException && error.name === "AbortError") return { status: "cancelled" }
  if (typeof error === "object" && error !== null && "code" in error && error.code === "cancelled") {
    return { status: "cancelled" }
  }
  return { status: "error", message: "Couldn’t save this file" }
}

export function fileSaveName(value: string): string {
  const base = value.normalize("NFC").split(/[\\/]/).pop() ?? ""
  let name = Array.from(base).filter(char => !/[\p{Cc}]/u.test(char))
    .join("").replace(/[<>:"|?*]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "")
  if (!name) name = "download"
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`
  while (new TextEncoder().encode(name).length > 180) name = Array.from(name).slice(0, -1).join("")
  return name.replace(/[.\s]+$/g, "") || "download"
}

function fileSaveMime(value: string): string {
  const mime = value.split(";")[0].trim().toLowerCase()
  return mime.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : "application/octet-stream"
}

function encodeChunk(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError")
}

async function browserSave(source: FileSource, signal?: AbortSignal): Promise<FileSaveResult> {
  const reader = source.stream.getReader()
  const parts: Uint8Array<ArrayBuffer>[] = []
  const onAbort = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    for (;;) {
      abortIfNeeded(signal)
      const part = await reader.read()
      abortIfNeeded(signal)
      if (part.done) break
      parts.push(new Uint8Array(part.value))
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const blob = new Blob(parts, { type: source.mime })
  abortIfNeeded(signal)
  if (source.size !== null && blob.size !== source.size) throw new Error("Length mismatch")
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  try {
    anchor.href = url
    anchor.download = source.name
    anchor.hidden = true
    document.body.appendChild(anchor)
    anchor.click()
    return { status: "started" }
  } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

async function nativeSave(source: FileSource, signal?: AbortSignal): Promise<FileSaveResult> {
  const attemptId = crypto.randomUUID()
  const reader = source.stream.getReader()
  let begun = false
  let completed = false
  let bytes = 0
  let sequence = 0
  const cancelNative = () => tauriInvoke("file_save_cancel", { attemptId }).catch(() => undefined)
  const onAbort = () => { void reader.cancel().catch(() => undefined); if (begun) void cancelNative() }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    abortIfNeeded(signal)
    const begin = await tauriInvoke<{ attemptId: string }>("file_save_begin", {
      payload: { attemptId, name: source.name, mime: source.mime, size: source.size },
    })
    begun = true
    if (begin.attemptId !== attemptId) throw new Error("Mismatched save attempt")
    abortIfNeeded(signal)
    for (;;) {
      const chunk = await reader.read()
      abortIfNeeded(signal)
      if (chunk.done) break
      for (let offset = 0; offset < chunk.value.byteLength; offset += FILE_SAVE_CHUNK_BYTES) {
        abortIfNeeded(signal)
        const part = chunk.value.subarray(offset, offset + FILE_SAVE_CHUNK_BYTES)
        const next = bytes + part.byteLength
        if (!Number.isSafeInteger(next) || (source.size !== null && next > source.size)) throw new Error("Length mismatch")
        const receipt = await tauriInvoke<{ attemptId: string; bytes: number; sequence: number }>("file_save_write_chunk", {
          payload: { attemptId, sequence, offset: bytes, data: encodeChunk(part) },
        })
        if (receipt.attemptId !== attemptId || receipt.bytes !== next || receipt.sequence !== sequence + 1) {
          throw new Error("Mismatched write receipt")
        }
        bytes = next
        sequence += 1
      }
    }
    if (source.size !== null && bytes !== source.size) throw new Error("Length mismatch")
    abortIfNeeded(signal)
    const result = await tauriInvoke<NativeReceipt>("file_save_commit", { payload: { attemptId, bytes } })
    if (result.attemptId !== attemptId) throw new Error("Mismatched save receipt")
    if (result.status === "cancelled") return { status: "cancelled" }
    const sharing = result.status === "started" && result.destination === "share"
    if ((!sharing && result.status !== "saved") || result.bytes !== bytes || result.name !== source.name
      || result.mime !== source.mime || !/^[a-f0-9]{64}$/.test(result.sha256)
      || (!sharing && !["downloads", "files", "document", "desktop"].includes(result.destination))) {
      throw new Error("Invalid save receipt")
    }
    completed = true
    if (sharing) return { status: "started", destination: "share" }
    return { status: "saved", name: result.name, mime: result.mime, bytes, sha256: result.sha256, destination: result.destination }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    if (begun && !completed) await cancelNative()
  }
}

async function saveSource(source: FileSource, signal?: AbortSignal): Promise<FileSaveResult> {
  try {
    abortIfNeeded(signal)
    return await (isTauri() ? nativeSave(source, signal) : browserSave(source, signal))
  } catch (error) {
    return signal?.aborted ? { status: "cancelled" } : normalizedError(error)
  }
}

export async function saveFile(blob: Blob, name: string, options: { signal?: AbortSignal } = {}): Promise<FileSaveResult> {
  try {
    return await saveSource({ name: fileSaveName(name), mime: fileSaveMime(blob.type), size: blob.size, stream: blob.stream() }, options.signal)
  } catch (error) { return normalizedError(error) }
}

export async function downloadUrl(url: string, name: string, options: { signal?: AbortSignal } = {}): Promise<FileSaveResult> {
  try {
    abortIfNeeded(options.signal)
    const response = await fetch(url, { credentials: "same-origin", signal: options.signal })
    if (!response.ok) throw new Error("Download failed")
    const mime = fileSaveMime(response.headers.get("content-type") ?? "")
    const length = response.headers.get("content-length")
    const size = length !== null && /^\d+$/.test(length) && !response.headers.get("content-encoding") ? Number(length) : null
    if (size !== null && !Number.isSafeInteger(size)) throw new Error("Invalid length")
    if (!response.body) throw new Error("Missing response body")
    return await saveSource({ name: fileSaveName(name), mime, size, stream: response.body }, options.signal)
  } catch (error) {
    return options.signal?.aborted ? { status: "cancelled" } : normalizedError(error)
  }
}
