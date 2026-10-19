import { describe, expect, it, vi } from "vitest"
import { readTranscriptionAudio, TRANSCRIPTION_MAX_BYTES, TRANSCRIPTION_MODEL, transcribeAudio, validateTranscriptionWav } from "./transcription"

function wav(samples = 16_000) {
  const audio = new Uint8Array(44 + samples * 2)
  const view = new DataView(audio.buffer)
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) {
    audio.set(new TextEncoder().encode(text), offset)
  }
  for (const [offset, value] of [[4, audio.length - 8], [16, 16], [24, 16_000], [28, 32_000], [40, samples * 2]]) view.setUint32(offset, value, true)
  for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(offset, value, true)
  return audio
}

function request(audio: Uint8Array, headers: Record<string, string> = {}) {
  return new Request("https://alook.test/api/audio/transcriptions", {
    method: "POST", headers: { "Content-Type": "audio/wav", ...headers }, body: Buffer.from(audio),
  })
}

describe("generic audio boundary", () => {
  it("accepts the device format through the exact 60 second limit", async () => {
    const audio = wav(16_000 * 60)
    expect(audio.length).toBe(TRANSCRIPTION_MAX_BYTES)
    expect(await readTranscriptionAudio(request(audio))).toEqual(audio)
  })

  it.each([[22, 2], [24, 48_000], [28, 1], [32, 4], [34, 8], [40, 2], [4, 40]])("rejects inconsistent format field %i", (offset, value) => {
    const audio = wav()
    const view = new DataView(audio.buffer)
    if ([22, 32, 34].includes(offset)) view.setUint16(offset, value, true)
    else view.setUint32(offset, value, true)
    expect(() => validateTranscriptionWav(audio)).toThrow("PCM16 WAV")
  })

  it("rejects empty, truncated and non-WAV input", async () => {
    expect(() => validateTranscriptionWav(wav(0))).toThrow()
    expect(() => validateTranscriptionWav(wav().subarray(0, 43))).toThrow()
    await expect(readTranscriptionAudio(request(wav(), { "Content-Type": "application/json" }))).rejects.toMatchObject({ status: 415 })
  })

  it("bounds actual streamed bytes even when the declared length lies", async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(TRANSCRIPTION_MAX_BYTES)); controller.enqueue(new Uint8Array(1)) },
      cancel,
    })
    const req = new Request("https://alook.test", { method: "POST", headers: { "Content-Type": "audio/wav", "Content-Length": "1" }, body: stream, duplex: "half" } as RequestInit)
    await expect(readTranscriptionAudio(req)).rejects.toMatchObject({ status: 413 })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects declared oversized input before consuming it", async () => {
    await expect(readTranscriptionAudio(request(wav(), { "Content-Length": String(TRANSCRIPTION_MAX_BYTES + 1) }))).rejects.toMatchObject({ status: 413 })
  })
})

describe("generic transcription", () => {
  it("uses the native model in transcription mode and returns text only", async () => {
    const run = vi.fn().mockResolvedValue({ text: "  你好，Samara。  ", segments: [{ text: "private" }] })
    const audio = wav()
    expect(await transcribeAudio({ run }, audio)).toBe("你好，Samara。")
    expect(run).toHaveBeenCalledWith(TRANSCRIPTION_MODEL, { audio: Buffer.from(audio).toString("base64"), task: "transcribe", vad_filter: true }, { signal: undefined })
  })

  it.each([{}, { text: "  " }, { text: "x".repeat(4001) }])("keeps empty/oversized results off the send path", async result => {
    const run = vi.fn().mockResolvedValue(result)
    await expect(transcribeAudio({ run }, wav())).rejects.toMatchObject({ status: 422 })
  })
})
