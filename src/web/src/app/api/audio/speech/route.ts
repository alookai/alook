import { audioPost } from "@/lib/audio/http"
import { readSpeechInput, synthesizeSpeech } from "@/lib/audio/speech"

export const POST = audioPost("audio:speech", async (request, ctx) => {
  const input = await readSpeechInput(request)
  return synthesizeSpeech(ctx.env.AI, input, request.signal)
})
