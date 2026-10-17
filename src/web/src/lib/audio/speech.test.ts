import { describe, expect, it, vi } from "vitest"
import { readSpeechInput, SPEECH_MODEL, SPEECH_MAX_BYTES, speechAudio, synthesizeSpeech } from "./speech"
const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])
function wav() {
  const audio = new Uint8Array(48)
  for (const [offset, tag] of [[0, "RIFF"], [8, "WAVEfmt "], [36, "data"]] as const) audio.set(new TextEncoder().encode(tag), offset)
  const view = new DataView(audio.buffer)
  for (const [offset, value] of [[4, 40], [16, 16], [24, 44_100], [28, 88_200], [40, 4]]) view.setUint32(offset, value, true)
  for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(offset, value, true)
  return audio
}
const request = (input: unknown, type = "application/json") => new Request("https://fixture.invalid/api/audio/speech", { method: "POST", headers: { "Content-Type": type }, body: JSON.stringify(input) })
const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer())
describe("generic speech input and native AI output", () => {
  it("bounds input and passes the explicit language unchanged to the native model", async () => {
    const input = await readSpeechInput(request({ text: "  你好，世界  ", lang: "zh" }))
    expect(input).toEqual({ text: "你好，世界", lang: "zh" })
    const run = vi.fn().mockResolvedValue({ audio: Buffer.from(mp3).toString("base64") })
    const controller = new AbortController()
    expect(await bytes(await synthesizeSpeech({ run }, input, controller.signal))).toEqual(mp3)
    expect(run).toHaveBeenCalledWith(SPEECH_MODEL, { prompt: "你好，世界", lang: "zh" }, { returnRawResponse: true, signal: controller.signal })
    expect(await readSpeechInput(request({ text: "Hello" }))).toEqual({ text: "Hello", lang: "en" })
  })
  it.each([null, [], {}, { text: "  " }, { text: "x".repeat(4001) }, { text: "hello", lang: 1 }, { text: "hello", lang: "en\nfoo" }, { text: "hello", model: "other" }])("rejects invalid or oversized text without calling AI: %j", async input => {
    await expect(readSpeechInput(request(input))).rejects.toMatchObject({ status: 400 })
  })
  it.each([new Uint8Array([0xff]), new TextEncoder().encode('{"text":"unfinished')])("rejects invalid UTF-8 or JSON before model work", async body => {
    const input = new Request("https://fixture.invalid/api/audio/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body })
    await expect(readSpeechInput(input)).rejects.toMatchObject({ status: 400, message: "Valid UTF-8 JSON is required" })
  })
  it("rejects a wrong media type and excessive actual bytes", async () => {
    await expect(readSpeechInput(request({ text: "Hi" }, "text/plain"))).rejects.toMatchObject({ status: 415 })
    await expect(readSpeechInput(request({ text: "x".repeat(33000) }))).rejects.toMatchObject({ status: 413 })
  })
  it("accepts both documented ordinary outputs and a typed audio Response", async () => {
    expect(await bytes(await speechAudio(mp3))).toEqual(mp3)
    expect(await bytes(await speechAudio({ audio: Buffer.from(mp3).toString("base64") }))).toEqual(mp3)
    expect(await bytes(await speechAudio(new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } })))).toEqual(mp3)
    expect(await bytes(await speechAudio(Response.json({ audio: Buffer.from(mp3).toString("base64") })))).toEqual(mp3)
  })
  it.each(["bytes", "base64", "json", "wav", "mislabeled mp3", "octet-stream"])("identifies native WAV from the actual %s bytes", async shape => {
    const audio = wav()
    const encoded = { audio: Buffer.from(audio).toString("base64") }
    const input = shape === "bytes" ? audio : shape === "base64" ? encoded : shape === "json" ? Response.json(encoded) : new Response(audio, { headers: { "Content-Type": shape === "wav" ? "audio/wav" : shape === "mislabeled mp3" ? "audio/mpeg" : "application/octet-stream" } })
    const response = await speechAudio(input)
    expect(response.headers.get("Content-Type")).toBe("audio/wav")
    expect(await bytes(response)).toEqual(audio)
  })
  it("validates a split WAV header then forwards it before the provider finishes", async () => {
    const audio = wav()
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn()
    const result = speechAudio(new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller }, cancel }), { headers: { "Content-Type": "audio/wav" } }))
    for (const part of [audio.subarray(0, 3), audio.subarray(3, 7), audio.subarray(7, 12)]) upstream.enqueue(part)
    const response = await result
    expect(response.headers.get("Content-Type")).toBe("audio/wav")
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(audio.subarray(0, 3))
    expect((await reader.read()).value).toEqual(audio.subarray(3, 7))
    expect((await reader.read()).value).toEqual(audio.subarray(7, 12))
    upstream.enqueue(audio.subarray(12))
    expect((await reader.read()).value).toEqual(audio.subarray(12))
    upstream.close()
    expect((await reader.read()).done).toBe(true)
    expect(cancel).not.toHaveBeenCalled()
  })
  it.each(["wrong container", "short header", "short RIFF size", "oversized RIFF size", "truncated audio", "excess audio"])("rejects invalid complete WAV: %s", async reason => {
    let audio = wav()
    if (reason === "wrong container") audio[8] = 0
    if (reason === "short header") audio = audio.slice(0, 11)
    if (reason === "short RIFF size") new DataView(audio.buffer).setUint32(4, 4, true)
    if (reason === "oversized RIFF size") new DataView(audio.buffer).setUint32(4, SPEECH_MAX_BYTES, true)
    if (reason === "truncated audio") audio = audio.slice(0, -1)
    if (reason === "excess audio") audio = new Uint8Array([...audio, 0])
    await expect(speechAudio({ audio: Buffer.from(audio).toString("base64") })).rejects.toMatchObject({ status: 502 })
  })
  it("cancels a WAV whose HTTP and RIFF lengths disagree", async () => {
    const cancel = vi.fn()
    const audio = wav()
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(audio.subarray(0, 12)) }, cancel })
    await expect(speechAudio(new Response(source, { headers: { "Content-Type": "audio/wav", "Content-Length": String(audio.length + 1) } }))).rejects.toMatchObject({ status: 502 })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it.each(["truncated", "excess"])("errors a %s WAV stream even without HTTP length", async reason => {
    const audio = wav()
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn()
    const pending = speechAudio(new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller }, cancel }), { headers: { "Content-Type": "audio/wav" } }))
    upstream.enqueue(audio.subarray(0, 12))
    const reader = (await pending).body!.getReader()
    await reader.read()
    if (reason === "truncated") upstream.close()
    else upstream.enqueue(new Uint8Array(audio.length))
    await expect(reader.read()).rejects.toMatchObject({ status: 502 })
    if (reason === "excess") expect(cancel).toHaveBeenCalledOnce()
  })
  it.each([{}, new Uint8Array(), { audio: "not base64!" }, { audio: "YQ==" }, new TextEncoder().encode('{"error":"provider"}'), new Uint8Array(SPEECH_MAX_BYTES + 1)])("rejects a false or oversized audio result", async input => {
    await expect(speechAudio(input)).rejects.toMatchObject({ status: 502 })
  })
  it("does not label an error or JSON bytes as MP3", async () => {
    await expect(speechAudio(Response.json({ error: "private provider detail" }, { status: 500 }))).rejects.toMatchObject({ status: 502 })
    await expect(speechAudio(new Response('{"error":"provider"}', { headers: { "Content-Type": "audio/mpeg" } }))).rejects.toMatchObject({ status: 502 })
  })
  it("returns the first audio bytes before the upstream finishes and propagates cancellation", async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn()
    const source = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller }, cancel }, { highWaterMark: 0 })
    const result = speechAudio(new Response(source, { headers: { "Content-Type": "audio/mpeg" } }))
    upstream.enqueue(mp3.subarray(0, 1))
    upstream.enqueue(mp3.subarray(1, 4))
    const response = await result
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(mp3.subarray(0, 1))
    expect((await reader.read()).value).toEqual(mp3.subarray(1, 4))
    expect(cancel).not.toHaveBeenCalled()
    upstream.enqueue(mp3.subarray(4))
    expect((await reader.read()).value).toEqual(mp3.subarray(4))
    await reader.cancel()
    expect(cancel).toHaveBeenCalledOnce()
  })
  it("does not pull the remaining model output until the consumer reads it", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(mp3))
    const response = await speechAudio(new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), { headers: { "Content-Type": "audio/mpeg" } }))
    expect(pull).toHaveBeenCalledTimes(1)
    const reader = response.body!.getReader()
    await reader.read()
    expect(pull).toHaveBeenCalledTimes(1)
    await reader.read()
    expect(pull).toHaveBeenCalledTimes(2)
    await reader.cancel()
  })
  it("cancels declared overflow and invalid prefixes before returning an audio response", async () => {
    for (const [chunk, declared] of [[mp3, String(SPEECH_MAX_BYTES + 1)], [new Uint8Array([1, 2, 3, 4]), null]] as const) {
      const cancel = vi.fn()
      const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(chunk) }, cancel })
      const headers = new Headers({ "Content-Type": "audio/mpeg" })
      if (declared) headers.set("Content-Length", declared)
      await expect(speechAudio(new Response(source, { headers }))).rejects.toMatchObject({ status: 502 })
      expect(cancel).toHaveBeenCalledOnce()
    }
  })
  it("errors and cancels a stream that exceeds the actual-byte cap", async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn()
    const result = speechAudio(new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller }, cancel }), { headers: { "Content-Type": "audio/mpeg" } }))
    upstream.enqueue(mp3)
    const reader = (await result).body!.getReader()
    await reader.read()
    upstream.enqueue(new Uint8Array(SPEECH_MAX_BYTES))
    await expect(reader.read()).rejects.toMatchObject({ status: 502 })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it("cancels a declared oversized JSON fallback without reading it", async () => {
    const cancel = vi.fn()
    const pull = vi.fn()
    const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    await expect(speechAudio(new Response(source, { headers: { "Content-Type": "application/json", "Content-Length": String(SPEECH_MAX_BYTES * 2) } }))).rejects.toMatchObject({ status: 502 })
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })
  it.each(["provider error", "truncated length"])("ends with a stream error on %s rather than successful partial audio", async reason => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const result = speechAudio(new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller } }), { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(mp3.length + 1) } }))
    upstream.enqueue(mp3)
    const reader = (await result).body!.getReader()
    await reader.read()
    if (reason === "provider error") upstream.error(new Error("private provider text"))
    else upstream.close()
    await expect(reader.read()).rejects.toMatchObject({ message: "Speech service returned invalid audio", status: 502 })
  })
})
