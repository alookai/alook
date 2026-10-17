import { MAX_MESSAGE_CONTENT_LENGTH } from "@alook/shared"
import { AudioError, readAudioBytes } from "./http"

export const SPEECH_MODEL = "@cf/myshell-ai/melotts"
export const SPEECH_MAX_BYTES = 4 * 1024 * 1024
export type SpeechInput = { text: string; lang: string }

export async function readSpeechInput(request: Request): Promise<SpeechInput> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AudioError("application/json is required", 415)
  const bytes = await readAudioBytes(request, 32 * 1024)
  let input: unknown
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  catch { throw new AudioError("Valid UTF-8 JSON is required", 400) }
  if (!input || typeof input !== "object" || Array.isArray(input) || !("text" in input) || typeof input.text !== "string" || Object.keys(input).some(key => key !== "text" && key !== "lang")) throw new AudioError("text and optional lang are required", 400)
  const text = input.text.trim()
  const lang = "lang" in input ? input.lang : "en"
  if (!text || text.length > MAX_MESSAGE_CONTENT_LENGTH) throw new AudioError(`text must contain 1–${MAX_MESSAGE_CONTENT_LENGTH} characters`, 400)
  if (typeof lang !== "string" || lang.length > 32 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang)) throw new AudioError("lang must be a language code", 400)
  return { text, lang }
}

const invalidAudio = () => new AudioError("Speech service returned invalid audio", 502)
const isMp3 = (bytes: Uint8Array) => bytes.byteLength >= 4 && (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
const isRiff = (bytes: Uint8Array) => bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46

function audioFormat(bytes: Uint8Array): { type: string; size?: number } {
  if (isMp3(bytes)) return { type: "audio/mpeg" }
  if (bytes.byteLength >= 12 && isRiff(bytes) && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8
    if (size > 44 && size <= SPEECH_MAX_BYTES) return { type: "audio/wav", size }
  }
  throw invalidAudio()
}

function decodedAudio(result: unknown): Response {
  let bytes: Uint8Array
  try {
    if (result instanceof Uint8Array) bytes = result
    else if (result && typeof result === "object" && "audio" in result && typeof result.audio === "string") {
      if (result.audio.length > Math.ceil(SPEECH_MAX_BYTES / 3) * 4 || result.audio.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(result.audio)) throw new Error("invalid base64 audio")
      bytes = Buffer.from(result.audio, "base64")
      if (Buffer.from(bytes).toString("base64") !== result.audio) throw new Error("invalid base64 audio")
    } else throw new Error("missing audio")
    if (bytes.byteLength > SPEECH_MAX_BYTES) throw invalidAudio()
    const format = audioFormat(bytes)
    if (format.size !== undefined && format.size !== bytes.byteLength) throw invalidAudio()
    return new Response(Uint8Array.from(bytes), { headers: { "Content-Type": format.type } })
  } catch { throw invalidAudio() }
}

async function streamAudio(response: Response): Promise<Response> {
  if (!response.body) throw invalidAudio()
  const reader = response.body.getReader()
  const prefix = new Uint8Array(12)
  const initial: Uint8Array[] = []
  let length = 0
  let prefixLength = 0
  let required = 4
  let format: ReturnType<typeof audioFormat>
  const declared = response.headers.get("content-length")
  let closed = false
  const stop = async () => {
    if (closed) return
    closed = true
    try { await reader.cancel() } catch {} finally { reader.releaseLock() }
  }
  try {
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > SPEECH_MAX_BYTES)) throw invalidAudio()
    while (prefixLength < required) {
      const next = await reader.read()
      if (next.done) throw invalidAudio()
      length += next.value.byteLength
      if (length > SPEECH_MAX_BYTES) throw invalidAudio()
      const take = Math.min(next.value.byteLength, prefix.length - prefixLength)
      prefix.set(next.value.subarray(0, take), prefixLength)
      prefixLength += take
      if (next.value.byteLength) initial.push(next.value)
      if (prefixLength >= 4 && isRiff(prefix)) required = 12
    }
    format = audioFormat(prefix.subarray(0, prefixLength))
    if (format.size !== undefined && (length > format.size || declared !== null && Number(declared) !== format.size)) throw invalidAudio()
  } catch { await stop(); throw invalidAudio() }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (initial.length) { controller.enqueue(initial.shift()!); return }
      try {
        const next = await reader.read()
        if (next.done) {
          if (declared !== null && length !== Number(declared) || format.size !== undefined && length !== format.size) throw invalidAudio()
          closed = true
          reader.releaseLock()
          controller.close()
          return
        }
        length += next.value.byteLength
        if (length > SPEECH_MAX_BYTES || format.size !== undefined && length > format.size) throw invalidAudio()
        controller.enqueue(next.value)
      } catch { await stop(); controller.error(invalidAudio()) }
    },
    async cancel() { await stop() },
  }, { highWaterMark: 0 })
  return new Response(body, { headers: { "Content-Type": format.type } })
}

export async function speechAudio(result: unknown): Promise<Response> {
  try {
    if (result instanceof Response) {
      if (!result.ok) { await result.body?.cancel(); throw invalidAudio() }
      const type = result.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
      if (type && ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "application/octet-stream"].includes(type)) return await streamAudio(result)
      if (type !== "application/json") { await result.body?.cancel(); throw invalidAudio() }
      result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readAudioBytes(result, Math.ceil(SPEECH_MAX_BYTES / 3) * 4 + 1024)))
    }
    return decodedAudio(result)
  } catch {
    if (result instanceof Response && result.body && !result.body.locked) await result.body.cancel().catch(() => undefined)
    throw invalidAudio()
  }
}

export async function synthesizeSpeech(ai: Pick<Ai, "run">, input: SpeechInput, signal?: AbortSignal): Promise<Response> {
  return speechAudio(await ai.run(SPEECH_MODEL, { prompt: input.text, lang: input.lang }, { returnRawResponse: true, signal }))
}
