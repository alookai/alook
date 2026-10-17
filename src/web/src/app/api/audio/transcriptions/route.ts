import { writeJSON } from "@/lib/middleware/helpers"
import { audioPost } from "@/lib/audio/http"
import { readTranscriptionAudio, transcribeAudio } from "@/lib/audio/transcription"

export const POST = audioPost("audio:transcriptions", async (request, ctx) => {
  const audio = await readTranscriptionAudio(request)
  const text = await transcribeAudio(ctx.env.AI, audio, request.signal)
  return writeJSON({ text })
})
