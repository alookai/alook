import { readD1Migrations } from "@cloudflare/vitest-plugin"
import { randomUUID } from "crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { execFile } from "child_process"
import { promisify } from "util"
import { pathToFileURL } from "url"
import { tmpdir } from "os"
import { resolve } from "path"
import { createRequire } from "module"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { getPlatformProxy } from "wrangler"
import { createDb } from "../../../shared/src/db/index"
import { user } from "../../../shared/src/db/schema"
import { communityAttachment, communityChannel, communityMessage, communityMessageAttachment, communityReadState, communityReadStateRevision } from "../../../shared/src/db/community-schema"
import { createMessage } from "../../../shared/src/db/queries/community/message"
import { fillHistoricalProfile, type HistoricalActor, type HistoricalRow } from "./e2e-ui/_fixtures/historical-profile"

type Condition = ReturnType<typeof communityMessage.id.getSQL>
const { and, asc, eq } = createRequire(import.meta.resolve("@alook/shared"))("drizzle-orm") as {
  and: (...conditions: Array<Condition | undefined>) => Condition | undefined
  asc: (column: unknown) => Condition
  eq: (column: unknown, value: unknown) => Condition
}

const root = mkdtempSync(resolve(tmpdir(), "alook-history-contract-"))
const options = { configPath: resolve(import.meta.dirname, "../../wrangler.toml"), persist: { path: resolve(root, "v3") }, remoteBindings: false, envFiles: [] }
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Pick<CloudflareEnv, "DB">>>>
let reader: typeof proxy | undefined
let db: ReturnType<typeof createDb>
const channels: string[] = []
const users: string[] = []
const attachments: string[] = []

beforeAll(async () => {
  proxy = await getPlatformProxy<Pick<CloudflareEnv, "DB">>(options)
  const migrations = await readD1Migrations(resolve(import.meta.dirname, "../../migrations"))
  for (const migration of migrations) await proxy.env.DB.batch(migration.queries.map(query => proxy.env.DB.prepare(query)))
  db = createDb(proxy.env.DB)
})

afterEach(async () => {
  if (!db) return
  for (const id of channels.splice(0)) {
    await db.delete(communityChannel).where(eq(communityChannel.id, id))
    expect(await db.select().from(communityMessage).where(eq(communityMessage.channelId, id))).toEqual([])
    expect(await db.select().from(communityReadState).where(eq(communityReadState.channelId, id))).toEqual([])
  }
  for (const id of attachments.splice(0)) {
    expect(await db.select().from(communityMessageAttachment).where(eq(communityMessageAttachment.attachmentId, id))).toEqual([])
    await db.delete(communityAttachment).where(eq(communityAttachment.id, id))
  }
  for (const id of users.splice(0)) await db.delete(user).where(eq(user.id, id))
})

afterAll(async () => {
  try {
    await reader?.dispose()
  } finally {
    try { await proxy?.dispose() } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

async function fixture() {
  const prefix = `contract_${randomUUID()}`
  const actors: HistoricalActor[] = (["alice", "bob"] as const).map(role => ({ role, id: `${prefix}_${role}`, email: `${prefix}_${role}@alook.test` }))
  for (const actor of actors) {
    users.push(actor.id)
    await db.insert(user).values({ id: actor.id, name: actor.id, email: actor.email, discriminator: actor.role === "alice" ? "0001" : "0002" })
  }
  const channelId = `${prefix}_dm`
  channels.push(channelId)
  await db.insert(communityChannel).values({ id: channelId, type: "dm" })
  const rows: HistoricalRow[] = Array.from({ length: 300 }, (_, index) => ({ author: "bob", content: `history ${index}\n\nbody ${index}` }))
  return { channelId, actors, rows, idPrefix: prefix, register: (_id: string) => {}, assertActive: () => {} }
}

describe("case historical profile through native local D1", () => {
  it("loads the actual fixture and its D1 module through the native Playwright worker", async () => {
    const directory = resolve(root, "worker-loader")
    mkdirSync(directory)
    const fixture = resolve(import.meta.dirname, "e2e-ui/_fixtures/case-fixture.ts")
    const history = pathToFileURL(resolve(import.meta.dirname, "e2e-ui/_fixtures/local-history.ts")).href
    const requireFromTest = createRequire(import.meta.url)
    const playwrightTest = requireFromTest.resolve("@playwright/test")
    const shared = requireFromTest.resolve("@alook/shared")
    writeFileSync(resolve(directory, "playwright.config.ts"), 'export default { testDir: ".", testMatch: "loader.spec.ts", workers: 1, retries: 0, timeout: 10000, reporter: "json" }\n')
    writeFileSync(resolve(directory, "loader.spec.ts"), `
      import { test, expect } from ${JSON.stringify(playwrightTest)}
      import { CommunityMessagesReadSchema } from ${JSON.stringify(shared)}
      import { test as actualCaseTest } from ${JSON.stringify(fixture)}
      test("actual D1 fixture worker load", async () => {
        expect(typeof CommunityMessagesReadSchema.parse).toBe("function")
        expect(actualCaseTest).toBeDefined()
        const module = await import(${JSON.stringify(history)})
        expect(typeof module.seedLocalHistory).toBe("function")
      })
    `)
    const { stdout } = await promisify(execFile)(process.execPath, [requireFromTest.resolve("@playwright/test/cli"), "test", "--config", resolve(directory, "playwright.config.ts"), "--tsconfig", resolve(import.meta.dirname, "../../tsconfig.json")], {
      cwd: resolve(import.meta.dirname, "../.."), timeout: 20_000,
    }).catch(error => {
      console.error(error.stdout)
      throw error
    })
    const report = JSON.parse(stdout)
    expect(report.errors).toEqual([])
    expect(report.stats.expected).toBe(1)
    expect(report.stats.unexpected).toBe(0)
    expect(report.suites[0].specs[0].tests[0].results[0].workerIndex).toBe(0)
  })
  it("preserves 300 ordered canonical rows and a nonauthor's unread state across binding consumers", async () => {
    const input = await fixture()
    const result = await fillHistoricalProfile(db, input)
    expect(result).toEqual({ ids: Array.from({ length: 300 }, (_, index) => `${input.idPrefix}_${String(index).padStart(6, "0")}`), count: 300, firstSeq: 1, lastSeq: 300 })
    reader = await getPlatformProxy<Pick<CloudflareEnv, "DB">>(options)
    const otherDb = createDb(reader.env.DB)
    const middle = await otherDb.select({ id: communityMessage.id, seq: communityMessage.seq, content: communityMessage.content }).from(communityMessage)
      .where(and(eq(communityMessage.channelId, input.channelId), eq(communityMessage.seq, 150)))
    expect(middle).toEqual([{ id: `${input.idPrefix}_000149`, seq: 150, content: "history 149\n\nbody 149" }])
    const states = await otherDb.select({ userId: communityReadState.userId, seq: communityReadState.lastReadSeq }).from(communityReadState).where(eq(communityReadState.channelId, input.channelId))
    expect(states).toEqual([{ userId: input.actors[1]!.id, seq: 300 }])
    expect(await otherDb.select({ revision: communityReadStateRevision.revision }).from(communityReadStateRevision).where(eq(communityReadStateRevision.userId, input.actors[1]!.id))).toEqual([{ revision: 300 }])
  })

  it("keeps an interleaved HTML relationship and each human author's own watermark", async () => {
    const input = await fixture()
    const attachmentId = `${input.idPrefix}_html`
    attachments.push(attachmentId)
    input.rows[145] = { author: "alice", create: async () => {
      await db.insert(communityAttachment).values({ id: attachmentId, uploaderId: input.actors[0]!.id, filename: "history.html", contentType: "text/html", size: 40, r2Key: attachmentId })
      const message = await createMessage(db, { id: `${input.idPrefix}_000145`, channelId: input.channelId, authorId: input.actors[0]!.id, authorKind: "human", content: `[alook-html-preview](${attachmentId})`, attachmentIds: [attachmentId] })
      return { messageId: message.id, attachmentId }
    } }
    const result = await fillHistoricalProfile(db, input)
    expect(result.ids[145]).toBe(`${input.idPrefix}_000145`)
    expect(await db.select({ attachmentId: communityMessageAttachment.attachmentId, position: communityMessageAttachment.position }).from(communityMessageAttachment)
      .where(eq(communityMessageAttachment.messageId, result.ids[145]!))).toEqual([{ attachmentId, position: 0 }])
    expect(await db.select({ userId: communityReadState.userId, seq: communityReadState.lastReadSeq }).from(communityReadState).where(eq(communityReadState.channelId, input.channelId)).orderBy(asc(communityReadState.userId)))
      .toEqual([{ userId: input.actors[0]!.id, seq: 146 }, { userId: input.actors[1]!.id, seq: 300 }])
  })

  it("rejects a foreign DB identity or a nonempty channel before adding history", async () => {
    const input = await fixture()
    await expect(fillHistoricalProfile(db, { ...input, actors: input.actors.map(actor => ({ ...actor, email: "foreign@alook.test" })) })).rejects.toThrow("actor identities")
    expect(await db.select().from(communityMessage).where(eq(communityMessage.channelId, input.channelId))).toEqual([])
    await createMessage(db, { channelId: input.channelId, authorId: input.actors[1]!.id, authorKind: "human", content: "existing" })
    await expect(fillHistoricalProfile(db, input)).rejects.toThrow("existing empty channel")
    expect(await db.select({ content: communityMessage.content }).from(communityMessage).where(eq(communityMessage.channelId, input.channelId))).toEqual([{ content: "existing" }])
  })

  it("rejects a pre-advanced reader without rewriting its watermark", async () => {
    const input = await fixture()
    await db.insert(communityReadState).values({ userId: input.actors[0]!.id, channelId: input.channelId, lastReadAt: "2026-01-01T00:00:00.000Z", lastReadSeq: 1 })
    await expect(fillHistoricalProfile(db, input)).rejects.toThrow("original unread case baseline")
    expect(await db.select().from(communityMessage).where(eq(communityMessage.channelId, input.channelId))).toEqual([])
    expect(await db.select({ seq: communityReadState.lastReadSeq }).from(communityReadState).where(eq(communityReadState.channelId, input.channelId))).toEqual([{ seq: 1 }])
  })

  it("stops writing when the case owner retires and leaves cleanup-addressable rows", async () => {
    const input = await fixture()
    const ids: string[] = []
    const retired = new Error("case retired")
    await expect(fillHistoricalProfile(db, { ...input, register: id => { ids.push(id) }, assertActive: () => { if (ids.length === 3) throw retired } })).rejects.toBe(retired)
    expect(await db.select({ id: communityMessage.id, seq: communityMessage.seq }).from(communityMessage).where(eq(communityMessage.channelId, input.channelId)).orderBy(asc(communityMessage.seq)))
      .toEqual([0, 1, 2].map(index => ({ id: `${input.idPrefix}_${String(index).padStart(6, "0")}`, seq: index + 1 })))
  })
})
