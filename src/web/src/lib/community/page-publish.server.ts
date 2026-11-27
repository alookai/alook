import { createHash } from "node:crypto"
import { AlookPageEmbedSchema, queries, type Database } from "@alook/shared"
import { fetchPageHost, pageHostOrigin } from "./page-viewer.server"

export async function registerPageArchive(db: Database, env: RuntimeEnv, botId: string, attachmentId: string) {
  const fail = (status: number, error: string) => ({ ok: false as const, status, error })
  const identity = createHash("sha256").update(JSON.stringify([botId, attachmentId])).digest("hex").slice(0, 32)
  const id = `page_${identity}`
  const existing = await queries.communityPage.getReadableResource(db, id, botId)
  if (existing) return { ok: true as const, page: { kind: "alook_page" as const, id: existing.id, type: existing.type, title: existing.title } }
  const origin = pageHostOrigin(env.ALOOK_PAGE_ORIGIN)
  if (!origin || !env.ALOOK_PAGE_HOST || !env.COMMUNITY_MEDIA || !env.ALOOK_PAGE_SERVICE_KEY || Buffer.byteLength(env.ALOOK_PAGE_SERVICE_KEY) < 32) return fail(503, "Page host unavailable")
  const attachment = await queries.communityAttachment.getOwnedAttachmentById(db, attachmentId, botId)
  if (!attachment || attachment.contentType !== "application/zip" || !attachment.size || attachment.size > 16 * 1024 * 1024) return fail(400, "A Page archive uploaded by this bot is required")
  const object = await env.COMMUNITY_MEDIA.get(attachment.r2Key)
  if (!object || object.size > 16 * 1024 * 1024) return fail(400, "Page archive unavailable")
  const artifactId = `art_${identity}`
  let response: Response
  try {
    const body = process.env.NODE_ENV === "development" ? await object.arrayBuffer() : object.body
    const init: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers: { authorization: `Bearer ${env.ALOOK_PAGE_SERVICE_KEY}`, "x-alook-subject": botId, "content-type": "application/zip" },
      body, ...(process.env.NODE_ENV === "development" ? {} : { duplex: "half" }), signal: AbortSignal.timeout(30_000),
    }
    response = await fetchPageHost(env.ALOOK_PAGE_HOST, origin, `/alook/import/${artifactId}`, init)
  } catch { return fail(503, "Page host unavailable; retry this publication") }
  if (!response.ok) { await response.body?.cancel(); return fail(response.status === 400 || response.status === 413 ? 400 : 503, "Page archive could not be published") }
  let raw: unknown
  try { raw = await response.json() } catch { return fail(503, "Invalid Page host response") }
  if (!raw || typeof raw !== "object" || !("artifactId" in raw) || raw.artifactId !== artifactId) return fail(503, "Invalid Page host response")
  const metadata = raw as { type?: unknown; title?: unknown }
  const embed = AlookPageEmbedSchema.safeParse({ kind: "alook_page", id: `page_${identity}`, type: metadata.type, title: metadata.title })
  if (!embed.success) return fail(503, "Invalid Page host response")
  const page = await queries.communityPage.createPage(db, { id, artifactId, botId, archiveAttachmentId: attachmentId, type: embed.data.type, title: embed.data.title, createdAt: new Date().toISOString() })
  return page ? { ok: true as const, page: embed.data } : fail(404, "Publisher unavailable")
}

export async function preparePagePublication(db: Database, botId: string, pageId: string) {
  const page = await queries.communityPage.getReadableResource(db, pageId, botId)
  if (!page) return { ok: false as const, status: 404, error: "Page not found" }
  return {
    ok: true as const,
    embeds: JSON.stringify([{ kind: "alook_page", id: page.id, type: page.type, title: page.title }]),
    statements: (messageId: string) => [queries.communityPage.pageBindingStatement(db, { id: page.id, messageId, authorId: botId })],
  }
}
