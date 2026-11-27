import { createHash } from "node:crypto"
import { AlookPageEmbedSchema, queries, type Database } from "@alook/shared"
import { pageHostOrigin } from "./page-viewer.server"

export async function preparePagePublication(db: Database, env: RuntimeEnv, botId: string, nonce: string, attachmentId: string) {
  const fail = (status: number, error: string) => ({ ok: false as const, status, error })
  const origin = pageHostOrigin(env.ALOOK_PAGE_ORIGIN)
  if (!origin || !env.ALOOK_PAGE_HOST || !env.COMMUNITY_MEDIA || !env.ALOOK_PAGE_SERVICE_KEY || Buffer.byteLength(env.ALOOK_PAGE_SERVICE_KEY) < 32) return fail(503, "Page host unavailable")
  const attachment = await queries.communityAttachment.getOwnedAttachmentById(db, attachmentId, botId)
  if (!attachment || attachment.contentType !== "application/zip" || !attachment.size || attachment.size > 16 * 1024 * 1024) return fail(400, "A Page archive uploaded by this bot is required")
  const object = await env.COMMUNITY_MEDIA.get(attachment.r2Key)
  if (!object || object.size > 16 * 1024 * 1024) return fail(400, "Page archive unavailable")
  const identity = createHash("sha256").update(JSON.stringify([botId, nonce])).digest("hex").slice(0, 32)
  const artifactId = `art_${identity}`
  let response: Response
  try {
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { authorization: `Bearer ${env.ALOOK_PAGE_SERVICE_KEY}`, "x-alook-subject": botId, "content-type": "application/zip" },
      body: object.body, duplex: "half", signal: AbortSignal.timeout(30_000),
    }
    response = await env.ALOOK_PAGE_HOST.fetch(new Request(`${origin}/alook/import/${artifactId}`, init))
  } catch { return fail(503, "Page host unavailable; retry this publication") }
  if (!response.ok) { await response.body?.cancel(); return fail(response.status === 400 || response.status === 413 ? 400 : 503, "Page archive could not be published") }
  let raw: unknown
  try { raw = await response.json() } catch { return fail(503, "Invalid Page host response") }
  if (!raw || typeof raw !== "object" || !("artifactId" in raw) || raw.artifactId !== artifactId) return fail(503, "Invalid Page host response")
  const metadata = raw as { type?: unknown; title?: unknown }
  const embed = AlookPageEmbedSchema.safeParse({ kind: "alook_page", id: `page_${identity}`, type: metadata.type, title: metadata.title })
  if (!embed.success) return fail(503, "Invalid Page host response")
  const now = new Date().toISOString()
  return {
    ok: true as const,
    embeds: JSON.stringify([embed.data]),
    statements: (messageId: string) => [queries.communityPage.pageBindingStatement(db, { id: embed.data.id, artifactId, messageId, botId, createdAt: now })],
  }
}
