import { createMigratedDb } from "../../../../../../shared/test/helpers/migrated-db"
import { describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { queries, type Database } from "@alook/shared"
import { handleCommunityMachineMessage } from "../../../../../../ws-do/src/ws-durable/machine-frames"
import { IDENTITY_KEY, type WsDurableContext } from "../../../../../../ws-do/src/ws-durable/internal"
import type { MachineRestartHooks } from "../../../../../../ws-do/src/ws-durable/machine-restart"

const fixture = vi.hoisted(() => ({ db: undefined as Database | undefined, botId: "" }))
vi.mock("@alook/shared", async original => ({ ...await original<typeof import("@alook/shared")>(), createDb: () => fixture.db }))
vi.mock("@/lib/db", () => ({ getDb: () => fixture.db }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: async () => ({ env: { DB: {} } }) }))
vi.mock("@/lib/middleware/community-agent-runner-auth", () => ({
  resolveBotActor: async (_db: Database, header: string) => header === "Bearer crk_test_fixture"
    ? { kind: "bot", actor: { botUserId: fixture.botId, ownerUserId: "owner", machineId: "machine", isActive: true } }
    : { kind: "error", response: NextResponse.json({ error: "invalid key" }, { status: 401 }) },
}))
vi.mock("@/lib/middleware/auth", () => ({
  resolveHumanAuth: async () => NextResponse.json({ error: "unauthorized" }, { status: 401 }),
  humanAuthPolicy: {},
}))
vi.mock("@/lib/community/create-bot.server", () => ({ createBotForUser: vi.fn() }))
vi.mock("@/lib/community/bots.server", () => ({ readCommunityBots: vi.fn(), tokenUsageDayWindow: vi.fn() }))

import { GET } from "./route"

describe("authenticated frame → migrated SQLite → bot list HTTP response", () => {
  it("reads the native observation without changing intent, and rejects absent/foreign machine identities", async () => {
    const { sqlite, db } = createMigratedDb()
    try {
      fixture.db = db
      sqlite.exec(`
        INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,isBot,discriminator)
        VALUES ('owner','Owner','owner@example.test',1,'2026-01-01','2026-01-01',0,'9999');
        INSERT INTO community_machine (id,user_id,display_name,hostname,platform,arch,available_runtimes,status,created_at,updated_at)
        VALUES ('machine','owner','Fixture','host','darwin','arm64','["codex"]','online','2026-01-01','2026-01-01');
      `)
      const { botId } = await queries.communityBot.createBot(fixture.db, { ownerId: "owner", name: "Observed", machineId: "machine", runtime: "codex", modelName: "requested" })
      fixture.botId = botId
      let identity: { userId: string; machineId: string; credentialHash: string } | undefined
      const storageGet = vi.fn(async (key: string) => key === IDENTITY_KEY ? identity : undefined)
      const context = { env: { DB: {} }, ctx: { storage: { get: storageGet } }, log: { warn: vi.fn() } } as unknown as WsDurableContext
      const frame = { type: "agent_model", agentId: botId, backendId: "codex", sessionInstanceId: "epoch", sessionId: "native-session", model: "served", source: "response", responseId: "native-reply", observedAt: new Date().toISOString() }
      const receive = (payload: unknown) => handleCommunityMachineMessage(context, {} as WebSocket, payload, {} as MachineRestartHooks)
      const read = async () => {
        const response = await GET(new NextRequest("http://localhost/api/community/bots", { headers: { Authorization: "Bearer crk_test_fixture" } }))
        expect(response.status).toBe(200)
        return (await response.json()).bots[0]
      }
      await receive(frame)
      expect((await read()).modelObservation).toBeUndefined()
      identity = { userId: "other-owner", machineId: "machine", credentialHash: "fixture" }
      await receive(frame)
      expect((await read()).modelObservation).toBeUndefined()
      identity = { userId: "owner", machineId: "machine", credentialHash: "fixture" }
      await receive(frame)
      const bot = await read()
      const { type: _, ...report } = frame
      expect(bot).toMatchObject({ id: botId, model: "requested", backendId: "codex", modelObservation: { ...report, machineId: "machine" } })
      await receive({ ...frame, model: "old", observedAt: "2020-01-01T00:00:00.000Z" })
      identity = { ...identity, machineId: "foreign-machine" }
      await receive({ ...frame, model: "foreign" })
      expect((await read()).modelObservation.model).toBe("served")
      expect((await GET(new NextRequest("http://localhost/api/community/bots"))).status).toBe(401)
      expect(sqlite.pragma("foreign_key_check")).toEqual([])
    } finally {
      fixture.db = undefined
      sqlite.close()
    }
  })
})
