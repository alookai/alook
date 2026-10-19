import { MAX_MESSAGE_CONTENT_LENGTH } from "@alook/shared"
import { AudioError, readAudioBytes } from "./http"

export const TRANSCRIPTION_MAX_BYTES = 44 + 16_000 * 2 * 60
export const TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo"

export async function readTranscriptionAudio(request: Request): Promise<Uint8Array> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "audio/wav") throw new AudioError("audio/wav is required", 415)
  const audio = await readAudioBytes(request, TRANSCRIPTION_MAX_BYTES)
  validateTranscriptionWav(audio)
  return audio
}

export function validateTranscriptionWav(audio: Uint8Array): void {
  const invalid = () => new AudioError("16 kHz mono PCM16 WAV with a 44 byte header is required", 400)
  if (audio.byteLength < 46 || audio.byteLength > TRANSCRIPTION_MAX_BYTES) throw invalid()
  const data = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const tag = (offset: number, expected: string) => [...expected].every((char, i) => audio[offset + i] === char.charCodeAt(0))
  if (!tag(0, "RIFF") || !tag(8, "WAVE") || !tag(12, "fmt ") || !tag(36, "data")
    || data.getUint32(4, true) !== audio.byteLength - 8
    || data.getUint32(16, true) !== 16 || data.getUint16(20, true) !== 1
    || data.getUint16(22, true) !== 1 || data.getUint32(24, true) !== 16_000
    || data.getUint32(28, true) !== 32_000 || data.getUint16(32, true) !== 2
    || data.getUint16(34, true) !== 16 || data.getUint32(40, true) !== audio.byteLength - 44
    || (audio.byteLength - 44) % 2 !== 0) throw invalid()
}

export async function transcribeAudio(ai: Pick<Ai, "run">, audio: Uint8Array, signal?: AbortSignal): Promise<string> {
  validateTranscriptionWav(audio)
  const result = await ai.run(TRANSCRIPTION_MODEL, {
    audio: Buffer.from(audio).toString("base64"),
    task: "transcribe",
    vad_filter: true,
  }, { signal })
  const text = typeof result.text === "string" ? result.text.trim() : ""
  if (!text) throw new AudioError("no speech found; record again", 422)
  if (text.length > MAX_MESSAGE_CONTENT_LENGTH) throw new AudioError("transcription is too long; record a shorter message", 422)
  return text
}
