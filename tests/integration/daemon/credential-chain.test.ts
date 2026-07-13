/**
 * Real-infra replacement for the deleted `credentialChain.e2e.test.ts`
 * (which exercised the credential proxy against `MockServer`). Starts the
 * daemon's REAL local credential proxy (`startCredentialProxy`) pointed at
 * the real web app origin (`APP_URL`) and drives it with a real per-launch
 * voucher bound to a real `crk_` runner key minted via the real
 * `/api/community/daemon/enroll-agent` route — proving the full
 * voucher → proxy → real-server chain, and that a forged voucher is
 * rejected AT THE PROXY, never reaching the real upstream.
 *
 * Requires `wrangler dev` (`@alook/web`) already running (`APP_URL`,
 * default `http://localhost:3000`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, signIn, fetchWithRetry, type TestSeed } from "@alook/test-utils"
import { CredentialBroker, startCredentialProxy, type RunningProxy } from "../../../src/daemon/src/credentials/credentialProxy"
import { createProxyServerApi } from "../../../src/daemon/src/cli/proxyServerApi"
import { seedPairedBot, cleanupPairedBot, type DaemonItFixture } from "./seed-helpers"

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"

let seed: TestSeed
let cookie: string
let fixture: DaemonItFixture
let runnerKey: string
let broker: CredentialBroker
let proxy: RunningProxy

beforeAll(async () => {
  seed = seedTestData()
  cookie = await signIn(seed.authEmail, seed.authPassword)
  fixture = await seedPairedBot(seed, cookie)

  const enrollRes = await fetchWithRetry(`${APP_URL}/api/community/daemon/enroll-agent`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.paired.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId: fixture.bot.botUserId }),
  })
  expect(enrollRes.ok).toBe(true)
    ; ({ runnerKey } = (await enrollRes.json()) as { runnerKey: string })

  // Upstream is the real web app's origin — the proxy itself rewrites
  // `/api/*` → `/api/community/agent/*` (mirrors `createDaemon`'s
  // `upstreamBaseUrl: opts.serverUrl` wiring).
  broker = new CredentialBroker({ upstreamBaseUrl: APP_URL })
  proxy = await startCredentialProxy(broker)
}, 30_000)

afterAll(async () => {
  await proxy?.close()
  if (fixture) cleanupPairedBot(seed, fixture)
  cleanupTestData(seed)
})

describe("daemon credential chain — real local proxy against the real web app", () => {
  it("a valid per-launch voucher reaches the real /api/community/agent/read route and gets a well-formed response", async () => {
    const reg = broker.mint(fixture.bot.botUserId, "launch-1", ["read", "send"], runnerKey)
    const api = createProxyServerApi({ proxyUrl: proxy.url, voucher: reg.voucher })

    const page = await api.read({
      agentId: fixture.bot.botUserId,
      channel: `/${fixture.serverId}/${fixture.channelId}`,
    })
    expect(Array.isArray(page.items)).toBe(true)
    expect(typeof page.hasMore).toBe("boolean")
  })

  it("rejects a forged/unknown voucher AT THE PROXY — distinct from what the real upstream would return for a bad crk_, proving upstream was never reached", async () => {
    const res = await fetch(`${proxy.url}/api/read`, {
      method: "POST",
      headers: { Authorization: "Bearer vch_this_was_never_minted", "content-type": "application/json" },
      body: JSON.stringify({ channel: `/${fixture.serverId}/${fixture.channelId}` }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; code: string }
    // This exact shape only comes from `CredentialBroker.check`'s own
    // rejection (see `credentialProxy.ts`) — the real upstream's own
    // `withAgentRunnerAuth` 401 for a bad `crk_` returns a DIFFERENT body
    // ("runner key revoked or unknown"), so this being the body proves the
    // request was rejected before the proxy ever swapped in a key and
    // forwarded anything upstream.
    expect(body).toEqual({ error: "invalid local agent proxy token", code: "invalid_proxy_token" })
  })
})
