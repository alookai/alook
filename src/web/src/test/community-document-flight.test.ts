import { describe, expect, it } from "vitest"
import { readCommunityDocumentSeedFromHtml } from "./e2e-ui/_fixtures/community-ssr-frame"

const profile = { id: "viewer", name: "Viewer", discriminator: "0042", avatar: null, avatarVersion: 2 }
const seed = { viewerId: "viewer", href: "/c/me/dm", generatedAt: 123, selfProfile: profile, entries: [], db: { collections: [] } }
const html = (flight: string) => `<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script>`

describe("document seed from actual Flight data framing", () => {
  it("reads the prior inline document seed", async () => {
    expect(await readCommunityDocumentSeedFromHtml(html(`0:${JSON.stringify({ child: { initialSeed: seed } })}\n`))).toEqual(seed)
  })

  it("resolves a deferred seed and shared records without loading Client Component modules", async () => {
    const value = { ...seed, selfProfile: "$c", entries: [{ target: { channelId: "dm", serverId: null }, data: { peer: "$c" } }] }
    const wire = `:HL["/static/style.css","style"]\n0:{"initialSeed":"$@a"}\n5:I["unused",["never-load.js"],"default"]\na:${JSON.stringify(value)}\nc:${JSON.stringify(profile)}\n`
    const decoded = await readCommunityDocumentSeedFromHtml(html(wire))
    expect(decoded.viewerId).toBe("viewer")
    expect(decoded.selfProfile).toEqual(profile)
    expect(decoded.entries[0].data.peer).toBe(decoded.selfProfile)
  })

  it("keeps UTF-8 length-framed text intact across script chunks and adjacent data rows", async () => {
    const body = `${"正文🙂".repeat(400)}\na:I["text, not an import"]\n0:{"initialSeed":"wrong"}`
    const value = { ...seed, entries: [{ target: { channelId: "dm", serverId: null }, data: { messages: [{ content: "$b" }] } }], db: { collections: [], label: "$$column" } }
    const wire = `0:{"initialSeed":"$@a"}\na:${JSON.stringify(value)}\nb:T${new TextEncoder().encode(body).length.toString(16)},${body}c:{"unused":true}\n`
    const split = Math.floor(wire.length / 2)
    const decoded = await readCommunityDocumentSeedFromHtml(html(wire.slice(0, split)) + html(wire.slice(split)))
    expect(decoded.entries[0].data.messages[0].content).toBe(body)
    expect(decoded.db).toMatchObject({ label: "$column" })
  })

  it("rejects a failed deferred seed instead of returning a partial receipt", async () => {
    await expect(readCommunityDocumentSeedFromHtml(html('0:{"initialSeed":"$@a"}\na:E{"digest":"seed-error"}\n'))).rejects.toThrow()
  })

  it("rejects missing and truncated document data", async () => {
    await expect(readCommunityDocumentSeedFromHtml(html('0:{"other":true}\n'))).rejects.toThrow()
    await expect(readCommunityDocumentSeedFromHtml(html('0:{"initialSeed":"$@a"}\na:Tff,short'))).rejects.toThrow()
  })
})
