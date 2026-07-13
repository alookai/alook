/**
 * Real-infra replacement for the deleted `controlPlane.e2e.test.ts` (which
 * exercised `WsControlServer` against the in-memory `MockServer`). This
 * suite instead drives the ACTUAL production path end to end:
 *
 *   POST /api/community/channels/:id/messages (human, real HTTP)
 *     → fanOutToChannel → enqueueBotWakes (dev HTTP transport)
 *     → alook-wake-worker (real process) → dispatchOneUnreadWake
 *     → sendWakeToMachine → alook-ws-do (real DO) → the daemon's real
 *       `WsControlChannel`, over a real WebSocket, receives `agent:wake`
 *     → the test (playing the "agent" — no CLI spawned) replies via the
 *       real `enroll-agent` → `inboxPull`/`ack`/`send` HTTP chain
 *     → the reply is visible via a real read of the channel.
 *
 * Requires `wrangler dev` (`@alook/web`), `@alook/ws-do dev`, and
 * `@alook/wake-worker dev` all already running (same servers CI's `e2e`
 * job boots for `@alook/cli`'s integration tests, plus `wake-worker`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { WebSocket } from "ws"
import {
  seedTestData,
  cleanupTestData,
  sessionRequest,
  signIn,
  fetchWithRetry,
  seedCommunityBot,
  cleanupCommunityBot,
  type TestSeed,
  type SeededCommunityBot,
} from "@alook/test-utils"
import { parseSeq } from "@alook/shared"
import { WsControlChannel } from "../../../src/daemon/src/server/wsControlChannel"
import type { HostCommand } from "../../../src/daemon/src/server/contract"
import { nanoid, seedPairedBot, cleanupPairedBot, type DaemonItFixture } from "./seed-helpers"

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
const WS_DO_URL = process.env.WS_DO_URL ?? "ws://localhost:8789"

async function waitFor<T>(check: () => T | undefined, timeoutMs = 15_000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (; ;) {
    const v = check()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error("waitFor: timed out")
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

async function waitForAsync<T>(
  check: () => Promise<T | undefined>,
  timeoutMs = 15_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastDetail = "no attempt yet"
  for (; ;) {
    try {
      const v = await check()
      if (v !== undefined) return v
      lastDetail = "check returned undefined"
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err)
    }
    if (Date.now() > deadline) throw new Error(`waitForAsync: timed out (${lastDetail})`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

async function waitForChannelReply(
  channelId: string,
  ownerCookie: string,
  replyText: string,
  timeoutMs = 15_000,
): Promise<void> {
  await waitForAsync(async () => {
    const readRes = await sessionRequest(`/api/community/channels/${channelId}/messages`, ownerCookie)
    const raw = await readRes.text()
    if (!readRes.ok) {
      throw new Error(`channel read failed status=${readRes.status} body=${raw.slice(0, 200)}`)
    }
    if (!raw.trim()) {
      throw new Error("channel read returned empty body")
    }
    const readBody = JSON.parse(raw) as { messages: Array<{ content: string }> }
    return readBody.messages.some((m) => m.content === replyText) ? true : undefined
  }, timeoutMs)
}

let seed: TestSeed
let cookie: string
let fixture: DaemonItFixture
let channel: WsControlChannel | undefined

beforeAll(async () => {
  seed = seedTestData()
  cookie = await signIn(seed.authEmail, seed.authPassword)
  fixture = await seedPairedBot(seed, cookie)
}, 30_000)

afterAll(() => {
  channel?.close()
  if (fixture) cleanupPairedBot(seed, fixture)
  cleanupTestData(seed)
})

describe("daemon control plane — real ws-do wake round-trip", () => {
  it("delivers a real agent:wake HostCommand over a real WsControlChannel, and the agent's real HTTP reply lands in the channel", async () => {
    const receivedCommands: HostCommand[] = []

    channel = new WsControlChannel({
      url: WS_DO_URL,
      headers: { Authorization: `Bearer ${fixture.paired.credential}` },
      webSocketFactory: (url, headers) => new WebSocket(url, { headers }) as never,
    })
    channel.onCommand((cmd) => {
      receivedCommands.push(cmd)
    })
    channel.onResync(() => ({
      ready: { runtimeReport: [{ id: "claude" }], runningAgents: [] },
      sessions: [],
    }))

    // Step: connect and wait for the daemon's `ready` handshake to actually
    // be sent — a wake with no ready daemon on the other end is recorded
    // `delivered_nowhere` and step below would hang waiting for a frame
    // that's never sent.
    const opened = new Promise<void>((resolve) => channel!.onOpen(resolve))
    channel.connect()
    await opened

    // Human owner posts a real message — exercises the real wake-producer
    // path (fanOutToChannel → enqueueBotWakes → dev HTTP transport →
    // wake-worker → forward-agent-wake → the DO → our open socket).
    const postRes = await sessionRequest(`/api/community/channels/${fixture.channelId}/messages`, cookie, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hey bot, wake up" }),
    })
    expect(postRes.ok).toBe(true)

    const wake = await waitFor(
      () => receivedCommands.find((c): c is HostCommand & { type: "agent:wake" } => c.type === "agent:wake"),
      15_000,
    )
    expect(wake.type).toBe("agent:wake")
    expect(wake.agentId).toBe(fixture.bot.botUserId)

    // Acting as the "agent" (no CLI spawned): mint the runner key, then
    // pull the backlog, ack it, and send a reply — all real HTTP against
    // /api/community/agent/*, exactly what a real agent's CLI would do.
    const enrollRes = await fetchWithRetry(`${APP_URL}/api/community/daemon/enroll-agent`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.paired.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: fixture.bot.botUserId }),
    })
    expect(enrollRes.ok).toBe(true)
    const { runnerKey } = (await enrollRes.json()) as { runnerKey: string; expiresAt: string | null }
    expect(runnerKey.startsWith("crk_")).toBe(true)

    const pullRes = await fetchWithRetry(`${APP_URL}/api/community/agent/inboxPull`, {
      method: "POST",
      headers: { Authorization: `Bearer ${runnerKey}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(pullRes.ok).toBe(true)
    // Wire `seq` is formatted `"#N"` (see `formatSeq`/`toAgentMessages`) —
    // the ack cursor schema wants the bare number back (`parseSeq`).
    const pulled = (await pullRes.json()) as { messages: Array<{ seq: string; channel: string }> }
    expect(pulled.messages.length).toBeGreaterThan(0)
    const lastPulled = pulled.messages[pulled.messages.length - 1]!

    const ackRes = await fetchWithRetry(`${APP_URL}/api/community/agent/ack`, {
      method: "POST",
      headers: { Authorization: `Bearer ${runnerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ cursors: [{ channel: lastPulled.channel, seq: parseSeq(lastPulled.seq) }] }),
    })
    expect(ackRes.ok).toBe(true)

    const replyText = `reply from the real credential chain ${nanoid()}`
    const sendRes = await fetchWithRetry(`${APP_URL}/api/community/agent/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${runnerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: `/${fixture.serverId}/${fixture.channelId}`, content: { text: replyText } }),
    })
    expect(sendRes.ok).toBe(true)
    const sendBody = (await sendRes.json()) as { state: string }
    expect(sendBody.state).toBe("sent")

    // The reply is now visible via a real owner-facing read of the channel.
    // Poll: wrangler/dev can briefly return empty bodies under fan-out load.
    await waitForChannelReply(fixture.channelId, cookie, replyText)
  }, 30_000)

  it("fans out an independent agent:wake to each of several bots bound to the same machine, over the same socket", async () => {
    // Reuses the already-open `channel` from the previous test — this is the
    // scenario the deleted `controlPlane.e2e.test.ts`'s "multiple agents each
    // reply" case covered: one control-plane connection correctly routes
    // simultaneous wakes for several DIFFERENT bots, not just one.
    expect(channel).toBeDefined()
    const extraBots: SeededCommunityBot[] = [
      seedCommunityBot({ ownerUserId: seed.userId, serverId: fixture.serverId, machineId: fixture.paired.machineId, runtime: "claude" }),
      seedCommunityBot({ ownerUserId: seed.userId, serverId: fixture.serverId, machineId: fixture.paired.machineId, runtime: "claude" }),
    ]

    try {
      const receivedWakes: Array<HostCommand & { type: "agent:wake" }> = []
      channel!.onCommand((cmd) => {
        if (cmd.type === "agent:wake") receivedWakes.push(cmd)
      })

      const postRes = await sessionRequest(`/api/community/channels/${fixture.channelId}/messages`, cookie, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hey team, wake up" }),
      })
      expect(postRes.ok).toBe(true)

      const targetIds = extraBots.map((b) => b.botUserId)
      await waitFor(() => {
        const seen = new Set(receivedWakes.map((c) => c.agentId))
        return targetIds.every((id) => seen.has(id)) ? true : undefined
      }, 15_000)

      // Each bot replies independently through its own real credential chain
      // — proves the wakes weren't just received, but are independently
      // actionable per-agent over the one shared socket.
      for (const bot of extraBots) {
        const enrollRes = await fetchWithRetry(`${APP_URL}/api/community/daemon/enroll-agent`, {
          method: "POST",
          headers: { Authorization: `Bearer ${fixture.paired.credential}`, "content-type": "application/json" },
          body: JSON.stringify({ agentId: bot.botUserId }),
        })
        expect(enrollRes.ok).toBe(true)
        const { runnerKey } = (await enrollRes.json()) as { runnerKey: string }

        const pullRes = await fetchWithRetry(`${APP_URL}/api/community/agent/inboxPull`, {
          method: "POST",
          headers: { Authorization: `Bearer ${runnerKey}`, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(pullRes.ok).toBe(true)
        const pulled = (await pullRes.json()) as { messages: Array<{ seq: string; channel: string }> }
        expect(pulled.messages.length).toBeGreaterThan(0)
        const lastPulled = pulled.messages[pulled.messages.length - 1]!

        await fetchWithRetry(`${APP_URL}/api/community/agent/ack`, {
          method: "POST",
          headers: { Authorization: `Bearer ${runnerKey}`, "content-type": "application/json" },
          body: JSON.stringify({ cursors: [{ channel: lastPulled.channel, seq: parseSeq(lastPulled.seq) }] }),
        })

        const replyText = `reply from ${bot.botUserId} ${nanoid()}`
        const sendRes = await fetchWithRetry(`${APP_URL}/api/community/agent/send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${runnerKey}`, "content-type": "application/json" },
          body: JSON.stringify({ channel: `/${fixture.serverId}/${fixture.channelId}`, content: { text: replyText } }),
        })
        expect(sendRes.ok).toBe(true)
        const sendBody = (await sendRes.json()) as { state: string }
        expect(sendBody.state).toBe("sent")

        await waitForChannelReply(fixture.channelId, cookie, replyText)
      }
    } finally {
      for (const bot of extraBots) cleanupCommunityBot(bot)
    }
  }, 45_000)
})
