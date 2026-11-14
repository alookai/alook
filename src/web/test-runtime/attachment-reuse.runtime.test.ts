/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { queries, createDb } from "@alook/shared"
import { handleAttachmentUpload } from "../src/lib/community/upload"
import { collectAttachmentObjects } from "../scripts/attachment-maintenance"
import { solidPngFixture, structuredJpegFixture } from "../src/test/fixtures/media"
import type { NextRequest } from "next/server"

const bindings = env as unknown as CloudflareEnv
let uploader: string
const files: string[] = []
const keys = new Set<string>()
const request = (name: string, bytes: Uint8Array, type = "application/pdf") => {
  const form = new FormData()
  form.set("file", new File([bytes], name, { type }))
  return new Request("https://example.test/upload", { method: "POST", body: form }) as NextRequest
}
beforeEach(async () => {
  uploader = `file-runtime-${crypto.randomUUID()}`
  await bindings.DB.prepare("INSERT INTO user(id,email,name,discriminator) VALUES (?,?,'File QA','0123')").bind(uploader, `${uploader}@example.test`).run()
})
afterEach(async () => {
  for (const id of files.splice(0)) await bindings.DB.prepare("DELETE FROM community_attachment WHERE id = ?").bind(id).run()
  for (const key of keys) await bindings.COMMUNITY_MEDIA.delete(key)
  keys.clear()
  await bindings.DB.prepare("DELETE FROM user WHERE id = ?").bind(uploader).run()
})

describe("file content storage on real D1/R2 bindings", () => {
  it("concurrent equal bytes share one object while file identity and metadata stay separate", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const [a, b] = await Promise.all([
      handleAttachmentUpload(request("a.pdf", bytes), bindings),
      handleAttachmentUpload(request("b.txt", bytes, "text/plain"), bindings),
    ])
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    keys.add(a.r2Key)
    expect(a.r2Key).toBe(b.r2Key)
    expect(a.filename).toBe("a.pdf"); expect(b.filename).toBe("b.txt")
    const db = createDb(bindings.DB)
    const rows = await Promise.all([a, b].map(result => queries.communityAttachment.createAttachment(db, {
      uploaderId: uploader, filename: result.filename, r2Key: result.r2Key, size: result.size, contentType: result.contentType,
    })))
    files.push(...rows.map(row => row.id))
    expect(rows[0]!.id).not.toBe(rows[1]!.id)
    expect(new Uint8Array(await (await bindings.COMMUNITY_MEDIA.get(a.r2Key))!.arrayBuffer())).toEqual(bytes)
    const listed = await bindings.COMMUNITY_MEDIA.list({ prefix: a.r2Key })
    expect(listed.objects).toHaveLength(1)
    await bindings.DB.prepare("DELETE FROM community_attachment WHERE id = ?").bind(rows[0]!.id).run()
    files.splice(files.indexOf(rows[0]!.id), 1)
    await collectAttachmentObjects(bindings, { apply: true, beforeWrite: async () => {}, record: async () => {} })
    expect(await bindings.COMMUNITY_MEDIA.get(a.r2Key)).not.toBeNull()
  })

  it("rejects a client hash and keeps different content separate despite equal filenames", async () => {
    const upload = (bytes: Uint8Array) => {
      const form = new FormData()
      form.set("file", new File([bytes], "same.pdf", { type: "application/pdf" }))
      return handleAttachmentUpload(new Request("https://example.test/upload", { method: "POST", body: form }) as NextRequest, bindings)
    }
    const forged = new FormData()
    forged.set("file", new File([new Uint8Array(16)], "same.pdf", { type: "application/pdf" }))
    forged.set("sha256", "0".repeat(64))
    const rejected = await handleAttachmentUpload(new Request("https://example.test/upload", { method: "POST", body: forged }) as NextRequest, bindings)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.response.status).toBe(400)
    const a = await upload(crypto.getRandomValues(new Uint8Array(16)))
    const b = await upload(crypto.getRandomValues(new Uint8Array(16)))
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    keys.add(a.r2Key); keys.add(b.r2Key)
    expect(a.r2Key).not.toBe(b.r2Key)
    expect(a.r2Key).not.toContain("0".repeat(64))
    expect(b.r2Key).not.toContain("0".repeat(64))
  })

  it("reuses exact image originals while keeping advisory dimensions and attachment ownership separate", async () => {
    const color = crypto.getRandomValues(new Uint8Array(3))
    const original = Uint8Array.from(solidPngFixture(10, 10, [color[0]!, color[1]!, color[2]!]))
    const make = (width: number) => {
      const form = new FormData()
      form.set("file", new File([original], "picture.png", { type: "image/png" }))
      form.set("width", String(width))
      form.set("height", "10")
      return new Request("https://example.test/upload", { method: "POST", body: form }) as NextRequest
    }
    const a = await handleAttachmentUpload(make(10), bindings)
    const b = await handleAttachmentUpload(make(20), bindings)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    keys.add(a.r2Key)
    expect(a.r2Key).toBe(b.r2Key)
    expect([a, b].map(result => ({ width: result.width, height: result.height, hasThumbnail: result.hasThumbnail })))
      .toEqual([{ width: 10, height: 10, hasThumbnail: true }, { width: 20, height: 10, hasThumbnail: true }])
    const rows = await Promise.all([a, b].map(result => queries.communityAttachment.createAttachment(createDb(bindings.DB), {
      uploaderId: uploader, filename: result.filename, r2Key: result.r2Key, size: result.size, contentType: result.contentType,
      width: result.width, height: result.height,
    })))
    files.push(...rows.map(row => row.id))
    expect(rows[0]!.id).not.toBe(rows[1]!.id)
    const persisted = await createDb(bindings.DB).query.communityAttachment.findMany({
      columns: { uploaderId: true, r2Key: true, thumbnailR2Key: true, width: true, height: true },
      where: (attachment, { and, eq, inArray }) => and(
        eq(attachment.uploaderId, uploader),
        inArray(attachment.id, [rows[0]!.id, rows[1]!.id]),
      ),
      orderBy: (attachment, { asc }) => asc(attachment.width),
    })
    expect(persisted).toEqual([
      { uploaderId: uploader, r2Key: a.r2Key, thumbnailR2Key: null, width: 10, height: 10 },
      { uploaderId: uploader, r2Key: a.r2Key, thumbnailR2Key: null, width: 20, height: 10 },
    ])
    const stored = await bindings.COMMUNITY_MEDIA.get(a.r2Key)
    expect(stored).not.toBeNull()
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(original)
    expect(new Uint8Array(stored!.checksums.sha256!)).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", original)))
    expect((await bindings.COMMUNITY_MEDIA.list({ prefix: a.r2Key })).objects).toHaveLength(1)
  })

  it("rejects the removed thumbnail protocol without changing an existing original", async () => {
    const original = crypto.getRandomValues(new Uint8Array(16))
    const first = await handleAttachmentUpload(request("picture.png", original, "image/png"), bindings)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    keys.add(first.r2Key)
    const before = await bindings.COMMUNITY_MEDIA.list({ prefix: "attachments/" })
    const form = new FormData()
    form.set("file", new File([original], "picture.png", { type: "image/png" }))
    form.set("thumbnail", new File([structuredJpegFixture(20, 10)], "thumbnail.jpg", { type: "image/jpeg" }))
    const rejected = await handleAttachmentUpload(new Request("https://example.test/upload", { method: "POST", body: form }) as NextRequest, bindings)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.response.status).toBe(400)
      expect(await rejected.response.text()).toContain("update your client")
    }
    expect((await bindings.COMMUNITY_MEDIA.list({ prefix: "attachments/" })).objects.map(object => object.key))
      .toEqual(before.objects.map(object => object.key))
    expect(new Uint8Array(await (await bindings.COMMUNITY_MEDIA.get(first.r2Key))!.arrayBuffer())).toEqual(original)
  })

  it("preserves legacy keys and bytes, and collects only explicit unreferenced objects offline", async () => {
    const id = crypto.randomUUID()
    files.push(id)
    const original = `channel/runtime/${id}/old.pdf`
    const thumb = `thread/runtime/${id}/thumbnail.jpg`
    const orphan = `dm/runtime/${id}/orphan.pdf`
    keys.add(original); keys.add(thumb); keys.add(orphan)
    const bytes = crypto.getRandomValues(new Uint8Array(12))
    const thumbnail = crypto.getRandomValues(new Uint8Array(7))
    await bindings.COMMUNITY_MEDIA.put(original, bytes)
    await bindings.COMMUNITY_MEDIA.put(thumb, thumbnail)
    await bindings.COMMUNITY_MEDIA.put(orphan, bytes)
    await queries.communityAttachment.createAttachment(createDb(bindings.DB), { id, uploaderId: uploader, filename: "old.pdf", r2Key: original, thumbnailR2Key: thumb, size: bytes.length })
    const record = async () => {}
    const candidates = new Set([original, thumb, orphan])
    await collectAttachmentObjects(bindings, { apply: false, record }, candidates)
    expect(await bindings.COMMUNITY_MEDIA.get(orphan)).not.toBeNull()
    await expect(collectAttachmentObjects(bindings, { apply: true, record }, candidates)).rejects.toThrow("quiescence")
    await collectAttachmentObjects(bindings, { apply: true, beforeWrite: async () => {}, record }, candidates)
    expect(await bindings.COMMUNITY_MEDIA.get(orphan)).toBeNull()
    const retained = await bindings.DB.prepare("SELECT r2_key, thumbnail_r2_key, filename FROM community_attachment WHERE id = ?").bind(id).first<any>()
    expect(retained).toEqual({ r2_key: original, thumbnail_r2_key: thumb, filename: "old.pdf" })
    expect(new Uint8Array(await (await bindings.COMMUNITY_MEDIA.get(original))!.arrayBuffer())).toEqual(bytes)
    expect(new Uint8Array(await (await bindings.COMMUNITY_MEDIA.get(thumb))!.arrayBuffer())).toEqual(thumbnail)
  })
})
