/**
 * Stress-seed the local community DB for perf diagnosis.
 *
 * See plans/community-switch-perf-diagnosis.md. This is a LOCAL diagnostic tool
 * — it is not wired into CI and ships nothing to prod.
 *
 * Usage:
 *   pnpm --filter @alook/web seed:stress [--servers=30] [--channels=40] \
 *     [--messages=60] [--server-url=http://localhost:3000] [--owner=perf-seed]
 *
 * Prerequisites:
 *   - The local dev stack is running (`pnpm --filter @alook/web dev`).
 *
 * Identity pinning (why this doesn't reuse the e2e `.auth` state):
 *   The Playwright e2e `global-setup` registers a NEW stamped user each run, so
 *   a server seeded under "alice-stamp-A" is invisible to a later perf run
 *   driving "alice-stamp-B". Instead this script establishes a STABLE identity
 *   over HTTP — a fixed email (`--owner`) + DEV_PASSWORD, auto-registered on
 *   first use — and records the resolved userId in the manifest so the perf
 *   spec drives as exactly that account.
 *
 * Right-sizing (why messages default is shallow):
 *   The switch hot-path loads only the FIRST PAGE of messages and re-renders
 *   the channel tree; message depth barely touches it. So defaults emphasize
 *   BREADTH (servers × channels, which stress sidebar/tree render) over depth.
 *   High `--messages` remains available for a targeted deep-channel probe.
 *
 * Idempotency:
 *   Servers named `Load Test NN`, channels `channel-NN`; re-runs top up to the
 *   target counts (never blindly re-POST), so `--messages=N` means "N each"
 *   across runs.
 */
import { parseArgs } from "node:util"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEV_PASSWORD, slugify } from "@alook/shared"
import { log } from "../src/lib/logger"

export interface SeedStressOptions {
  servers: number
  channels: number
  messages: number
  serverUrl: string
  owner: string
}

const DEFAULTS: SeedStressOptions = {
  servers: 30,
  channels: 40,
  messages: 60,
  serverUrl: "http://localhost:3000",
  owner: "perf-seed",
}

/** Parse + validate CLI args. Exported for unit testing (no network). */
export function parseSeedArgs(argv: string[]): SeedStressOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      servers: { type: "string" },
      channels: { type: "string" },
      messages: { type: "string" },
      "server-url": { type: "string" },
      owner: { type: "string" },
    },
    allowPositionals: false,
  })

  const num = (raw: string | undefined, fallback: number, name: string): number => {
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`--${name} must be a non-negative integer, got "${raw}"`)
    }
    return n
  }

  return {
    servers: num(values.servers, DEFAULTS.servers, "servers"),
    channels: num(values.channels, DEFAULTS.channels, "channels"),
    messages: num(values.messages, DEFAULTS.messages, "messages"),
    serverUrl: values["server-url"] ?? DEFAULTS.serverUrl,
    owner: values.owner ?? DEFAULTS.owner,
  }
}

export interface SeedManifest {
  owner: { email: string; userId: string }
  serverUrl: string
  createdAt: string
  servers: Array<{
    id: string
    name: string
    channels: Array<{ id: string; name: string; messageCount: number }>
  }>
}

// ---------------------------------------------------------------------------
// HTTP layer — a stable, cookie-bearing client against the local dev server.
// ---------------------------------------------------------------------------

function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 403 || status >= 500
}

/**
 * Merge Set-Cookie lines into an existing jar (in place). Exported for testing
 * the regression where better-auth's two-cookie handshake (`session_token` +
 * `session_data`, delivered across separate responses) must MERGE, not replace
 * — a replace dropped one and 401'd the next call.
 */
export function mergeSetCookies(jar: Map<string, string>, lines: string[]): void {
  for (const line of lines) {
    const pair = line.split(";")[0].trim()
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    const name = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    if (value === "") jar.delete(name) // empty value = cookie deletion
    else jar.set(name, value)
  }
}

/** Extract already-split Set-Cookie lines from a Response, robust to undici. */
export function extractSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie()
  return headers.get("set-cookie")?.split(/,(?=[^;,]+=)/) ?? []
}

class SeedClient {
  // A real cookie jar keyed by name so successive responses MERGE rather than
  // replace. better-auth sets `session_token` and `session_data` in separate
  // responses; a replace-semantics jar would drop one and 401 the next call.
  private readonly jar = new Map<string, string>()
  constructor(private readonly baseUrl: string) {}

  private cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ")
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const cookie = this.cookieHeader()
    return {
      "Content-Type": "application/json",
      Origin: this.baseUrl,
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    }
  }

  private captureCookie(res: Response): void {
    mergeSetCookies(this.jar, extractSetCookies(res))
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    let lastStatus = 0
    // Rate-limit (429) can recur many times during a large message seed, so
    // allow generous attempts and honor Retry-After rather than failing.
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      this.captureCookie(res)
      if (res.ok) return (await res.json()) as T
      lastStatus = res.status
      if (res.status === 429) {
        // Honor Retry-After (seconds); default to a full window if absent.
        const retryAfter = Number(res.headers.get("Retry-After"))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 10_000)
        continue
      }
      if (!isRetryableStatus(res.status)) break
      await sleep(400)
    }
    throw new Error(`POST ${path} failed (${lastStatus})`)
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() })
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`)
    return (await res.json()) as T
  }

  /**
   * Establish a stable identity: try sign-in, fall back to sign-up on failure
   * (mirrors the dev sign-in UI's `handleDevSignIn`). Both set the session
   * cookie we then carry for all seeding.
   */
  async authenticate(email: string): Promise<void> {
    const body = { email, password: DEV_PASSWORD }
    const signIn = await fetch(`${this.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    this.captureCookie(signIn)
    if (signIn.ok) return

    const signUp = await fetch(`${this.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name: email.split("@")[0], email, password: DEV_PASSWORD }),
    })
    this.captureCookie(signUp)
    if (!signUp.ok) {
      throw new Error(
        `Could not establish seed identity for ${email} (sign-in ${signIn.status}, sign-up ${signUp.status}). Is the dev server running?`,
      )
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Run `items` through `fn` with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ---------------------------------------------------------------------------
// Seeding logic
// ---------------------------------------------------------------------------

// `community:msgSend` is rate-limited per-user to 30 messages / 10s (see
// src/shared/src/lib/rate-limits.ts), keyed on userId — ONE bucket shared
// across every channel/server. Pace proactively under that ceiling so the seed
// rarely trips 429 (the post() retry honors Retry-After as a safety net), and
// keep concurrency modest so a burst can't overshoot between pacer ticks.
const MESSAGE_CONCURRENCY = 4
const MSG_RATE_MAX = 28 // stay just under the server's 30/10s
const MSG_RATE_WINDOW_MS = 10_000

/** Sliding-window pacer: await a slot before each rate-limited send. */
export class RatePacer {
  private readonly stamps: number[] = []
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  async acquire(now: () => number = Date.now): Promise<void> {
    for (;;) {
      const t = now()
      while (this.stamps.length && t - this.stamps[0] >= this.windowMs) this.stamps.shift()
      if (this.stamps.length < this.max) {
        this.stamps.push(t)
        return
      }
      const waitMs = this.windowMs - (t - this.stamps[0]) + 5
      await sleep(waitMs)
    }
  }
}

interface ServerRow { id: string; name: string }
interface ChannelRow { id: string; name: string; categoryId?: string | null }

async function ensureServer(client: SeedClient, existing: ServerRow[], name: string): Promise<string> {
  // The server route slugifies the name before storing (`"Load Test 01"` ->
  // `"Load-Test-01"`), so idempotency must compare against the SLUGIFIED form —
  // matching the raw input would never hit and every re-run would duplicate.
  const slug = slugify(name)
  const found = existing.find((s) => s.name === slug)
  if (found) return found.id
  const data = await client.post<{ server: { id: string } }>("/api/community/servers", { name })
  return data.server.id
}

async function listChannels(client: SeedClient, serverId: string): Promise<ChannelRow[]> {
  const detail = await client.get<{
    categories: Array<{ channels: ChannelRow[] }>
  }>(`/api/community/servers/${serverId}`)
  return detail.categories.flatMap((c) => c.channels)
}

async function ensureChannel(
  client: SeedClient,
  serverId: string,
  existing: ChannelRow[],
  name: string,
): Promise<string> {
  // Channel names are slugified server-side too — compare against the slug.
  const slug = slugify(name)
  const found = existing.find((c) => c.name === slug)
  if (found) return found.id
  const data = await client.post<{ channel: { id: string } }>(
    `/api/community/servers/${serverId}/channels`,
    { name, type: "text" },
  )
  return data.channel.id
}

async function countMessages(client: SeedClient, channelId: string): Promise<number> {
  // The list endpoint pages newest-first; for idempotency we only need to know
  // whether the channel already has >= target. Read one large page and count;
  // if it reports hasMore, it already far exceeds any sane seed target.
  const data = await client.get<{ messages: unknown[]; hasMore?: boolean }>(
    `/api/community/channels/${channelId}/messages?limit=100`,
  )
  return data.hasMore ? Number.MAX_SAFE_INTEGER : data.messages.length
}

async function topUpMessages(
  client: SeedClient,
  channelId: string,
  target: number,
  channelName: string,
  pacer: RatePacer,
): Promise<number> {
  const current = await countMessages(client, channelId)
  if (current >= target) return current
  const toCreate = target - current
  const indices = Array.from({ length: toCreate }, (_, i) => current + i + 1)
  await mapWithConcurrency(indices, MESSAGE_CONCURRENCY, async (n) => {
    // Proactively pace under the shared per-user msgSend limit before sending.
    await pacer.acquire()
    await client.post(`/api/community/channels/${channelId}/messages`, {
      content: `${channelName} stress message #${n}`,
    })
  })
  return target
}

export async function runSeedStress(opts: SeedStressOptions): Promise<SeedManifest> {
  const client = new SeedClient(opts.serverUrl)
  const email = `${opts.owner}@alook.test`

  log.info("[seed] establishing stable identity", { email })
  await client.authenticate(email)
  const me = await client.get<{ userId: string }>("/api/ws/token")
  log.info("[seed] identity ready", { userId: me.userId })

  const existingServers = await client.get<{ servers: ServerRow[] }>("/api/community/servers")

  // One pacer for the whole run — the msgSend limit is a single per-user bucket
  // shared across all channels/servers, so pacing must be global, not per-channel.
  const pacer = new RatePacer(MSG_RATE_MAX, MSG_RATE_WINDOW_MS)

  const manifest: SeedManifest = {
    owner: { email, userId: me.userId },
    serverUrl: opts.serverUrl,
    createdAt: new Date().toISOString(),
    servers: [],
  }

  for (let s = 1; s <= opts.servers; s++) {
    const serverName = `Load Test ${String(s).padStart(2, "0")}`
    const serverId = await ensureServer(client, existingServers.servers, serverName)

    const existingChannels = await listChannels(client, serverId)
    const channelEntries: SeedManifest["servers"][number]["channels"] = []

    for (let c = 1; c <= opts.channels; c++) {
      const channelName = `channel-${String(c).padStart(2, "0")}`
      const channelId = await ensureChannel(client, serverId, existingChannels, channelName)
      const count = await topUpMessages(client, channelId, opts.messages, channelName, pacer)
      channelEntries.push({ id: channelId, name: slugify(channelName), messageCount: count })
    }

    // Record the SLUGIFIED name — that's what's stored and rendered in the rail.
    manifest.servers.push({ id: serverId, name: slugify(serverName), channels: channelEntries })
    log.info("[seed] server ready", { serverName: slugify(serverName), channels: channelEntries.length })
  }

  return manifest
}

const ARTIFACTS_DIR = resolve(import.meta.dirname, "..", "perf-artifacts")
const MANIFEST_PATH = resolve(ARTIFACTS_DIR, "seed-manifest.json")

async function main(): Promise<void> {
  const opts = parseSeedArgs(process.argv.slice(2))
  log.info("[seed] starting", { ...opts })
  const manifest = await runSeedStress(opts)
  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
  const totalMsgs = manifest.servers.reduce(
    (sum, s) => sum + s.channels.reduce((cs, c) => cs + c.messageCount, 0),
    0,
  )
  log.info("[seed] done", {
    servers: manifest.servers.length,
    channels: manifest.servers.reduce((n, s) => n + s.channels.length, 0),
    messages: totalMsgs,
    manifest: MANIFEST_PATH,
  })
}

// Only run when invoked directly (not when imported by unit tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error("[seed] failed", { error: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  })
}
