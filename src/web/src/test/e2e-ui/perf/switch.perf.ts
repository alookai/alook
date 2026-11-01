/**
 * Perf-diagnosis harness for community server/channel switching.
 *
 * ## Perf diagnosis (workflow)
 *   1. pnpm --filter @alook/web seed:stress          # heavy local dataset
 *   2. NEXT_PUBLIC_PERF_TRACE=1 pnpm --filter @alook/web dev
 *   3. pnpm --filter @alook/web perf:switch          # this spec + report
 *   → perf-artifacts/switch-report.md
 *
 * Caveats:
 *   - NEXT_PUBLIC_MOCK_NETWORK must be UNSET (it injects a ~300ms dev delay
 *     per apiFetch that would poison every network measurement).
 *   - NOT in CI and never shipped to prod: this config matches *.perf.ts,
 *     the CI e2e-ui workflow matches *.spec.ts, and the instrument is
 *     double-gated on NEXT_PUBLIC_PERF_TRACE + NODE_ENV.
 *   - Against a live dev build each switch is slow (full API fan-out + paint +
 *     reflow settle), so the matrix defaults SMALL and is env-tunable:
 *     PERF_CHANNEL_SWITCHES (default 3), PERF_SERVER_SWITCHES (default 3).
 *   - The capture is flushed to switch-events.json after every switch. The
 *     runner clears old artifacts first and only reports a successful run.
 *
 * LOCAL-ONLY — runs via
 * playwright.perf.config.ts, which has NO global-setup, so the stress-seeded
 * DB is preserved and this spec drives as the STABLE seed identity recorded in
 * the manifest.
 *
 * It measures PERCEIVED latency (click → content stable), not raw request ms,
 * across three cache states (cold / memory-warm / disk-warm). All timing is
 * captured in-page via one browser clock. Raw capture is written to
 * perf-artifacts/switch-events.json for scripts/perf-report.ts to consume.
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEV_PASSWORD } from "@alook/shared"
import { PERSIST_BUSTER, PERSIST_CACHE_PREFIX, PERSIST_VERSION } from "@/lib/query-persister"
import { communityKeys } from "@/lib/query-keys"
import { operatePerfQueryCache } from "./perf-query-cache"
import { tid } from "../_fixtures/testids"
import type {
  CacheState,
  CaptureFile,
  CapturedWarmReload,
  CapturedSwitch,
  SwitchKind,
  PerfTarget,
  PerfStableTarget,
} from "./perf-capture-types"

const BASE_URL = process.env.ALOOK_SERVER_URL || "http://localhost:3000"
const ARTIFACTS_DIR = resolve(__dirname, "..", "..", "..", "..", "perf-artifacts")
const SEED_MANIFEST = resolve(ARTIFACTS_DIR, "seed-manifest.json")
const CAPTURE_OUT = resolve(ARTIFACTS_DIR, "switch-events.json")

interface SeedManifest {
  owner: { email: string; userId: string }
  servers: Array<{ id: string; name: string; channels: Array<{ id: string; name: string }> }>
}

function loadManifest(): SeedManifest {
  try {
    return JSON.parse(readFileSync(SEED_MANIFEST, "utf8")) as SeedManifest
  } catch {
    throw new Error(
      `Missing ${SEED_MANIFEST}. Run \`pnpm --filter @alook/web seed:stress\` first.`,
    )
  }
}

/** Sign in (or up) the stable seed identity over HTTP and inject cookies. */
async function authenticateAs(context: BrowserContext, email: string): Promise<void> {
  const api = context.request
  let res = await api.post(`${BASE_URL}/api/auth/sign-in/email`, {
    data: { email, password: DEV_PASSWORD },
  })
  if (!res.ok()) {
    res = await api.post(`${BASE_URL}/api/auth/sign-up/email`, {
      data: { name: email.split("@")[0], email, password: DEV_PASSWORD },
    })
  }
  if (!res.ok()) {
    throw new Error(`Could not authenticate seed identity ${email} (${res.status()})`)
  }
}

function samplePerfTarget(target: PerfTarget) {
  const path = location.pathname.split("/")
  if (path.length !== 5 || path[1] !== "c" || path[2] !== "channels" || decodeURIComponent(path[3]) !== target.serverId) return false
  const channelId = decodeURIComponent(path[4])
  if (!channelId || target.channelId !== undefined && channelId !== target.channelId) return false
  const visible = (element: HTMLElement) => {
    const style = getComputedStyle(element)
    return !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const surfaces = [...document.querySelectorAll<HTMLElement>('[data-slot="community-conversation-surface"]')]
    .filter(surface => surface.dataset.channelId === channelId && visible(surface))
  if (surfaces.length !== 1) return false
  const surface = surfaces[0]
  const root = surface.querySelector<HTMLElement>(`[data-testid="${target.messageScrollerId}"]`)
  if (!root || !visible(root)) return false
  const skeleton = root.querySelector('[data-slot="skeleton"]')
  if (skeleton && window.__PERF_SKELETON_TS__ == null) window.__PERF_SKELETON_TS__ = performance.now()
  const content = root.querySelector<HTMLElement>("[data-message-list-content]")
  if (!content || !visible(content) || skeleton || surface.getAttribute("aria-busy") === "true" || root.getAttribute("aria-busy") === "true") return false
  const bounds = root.getBoundingClientRect()
  const rows = [...content.querySelectorAll<HTMLElement>("[data-msg-id]")]
  const inViewport = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
      && rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right
  }
  const painted = rows.some(row => visible(row) && inViewport(row))
  const emptyTail = content.querySelector<HTMLElement>("[data-message-empty-tail]")
  const empty = rows.length === 0 && content.dataset.initialPositionPhase === "revealed" && !content.querySelector('[role="alert"]')
    && emptyTail !== null && inViewport(emptyTail)
  if (!painted && !empty) return false
  if (window.__PERF_PAINTED_TS__ == null) window.__PERF_PAINTED_TS__ = performance.now()
  return { root, content, channelId, contentKind: painted ? "messages" as const : "empty" as const }
}

// In-page instrumentation installed before each measured switch. Reads the
// react-scan ring buffer + performance marks + resource timings + a
// ResizeObserver on the message scroll container, all on the browser clock.
const INPAGE_SETUP = `
(() => {
  const readTarget = (${samplePerfTarget.toString()});
  window.__PERF_RESOURCE_OBSERVER__?.disconnect();
  window.__PERF_LAYOUT_OBSERVER__?.disconnect();
  window.__PERF_RESIZE_OBSERVER__?.disconnect();
  let observedRoot = null;
  let observedContent = null;
  let resizeStart = 0;
  window.__PERF_RESOURCES__ = [];
  window.__PERF_SHIFTS__ = [];
  window.__PERF_RESIZES__ = [];
  const ro = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name.includes('/api/community/')) {
        window.__PERF_RESOURCES__.push({ name: e.name, startTime: e.startTime, responseEnd: e.responseEnd });
      }
    }
  });
  ro.observe({ type: 'resource', buffered: true });
  window.__PERF_RESOURCE_OBSERVER__ = ro;
  const lo = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      // KEEP hadRecentInput entries — the click-triggered reflow is exactly what
      // standard CLS filtering drops, and it's what we're measuring.
      window.__PERF_SHIFTS__.push({ ts: e.startTime, value: e.value, hadRecentInput: e.hadRecentInput });
    }
  });
  try { lo.observe({ type: 'layout-shift', buffered: true }); } catch (_) {}
  window.__PERF_LAYOUT_OBSERVER__ = lo;
  // Attach a ResizeObserver to the message scroll container. The container is
  // persistent, but on a cold switch it may be re-created (React swaps the
  // subtree), so a once-only global guard would leave the observer watching a
  // detached node and never fire again — hence NO cross-switch guard here, and
  // we disconnect the prior observer before re-observing the current root.
  window.__PERF_ATTACH_RESIZE__ = (target) => {
    const sample = readTarget(target);
    if (!sample) return false;
    if (window.__PERF_RESIZE_OBSERVER__) window.__PERF_RESIZE_OBSERVER__.disconnect();
    observedRoot = sample.root;
    observedContent = sample.content;
    resizeStart = window.__PERF_RESIZES__.length;
    const rz = new ResizeObserver(() => { window.__PERF_RESIZES__.push(performance.now()); });
    rz.observe(observedRoot);
    rz.observe(observedContent);
    window.__PERF_RESIZE_OBSERVER__ = rz;
    return true;
  };
  window.__PERF_WAIT_FOR_STABLE_RESIZE__ = (target) => new Promise((resolve, reject) => {
    let previousRoot = null;
    let previousContent = null;
    let previous = '';
    let unchangedFrames = 0;
    let observedFrames = 0;
    const sample = () => {
      observedFrames += 1;
      const targetSample = readTarget(target);
      if (!targetSample) {
        previous = '';
        unchangedFrames = 0;
        if (observedFrames >= 120) {
          reject(new Error('target message content did not become visible'));
          return;
        }
        requestAnimationFrame(sample);
        return;
      }
      const { root, content, channelId, contentKind } = targetSample;
      if (observedRoot !== root || observedContent !== content) window.__PERF_ATTACH_RESIZE__(target);
      if (previousRoot !== root || previousContent !== content) {
        previous = '';
        unchangedFrames = 0;
      }
      previousRoot = root;
      previousContent = content;
      const rootRect = root.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const current = [rootRect.width, rootRect.height, contentRect.width, contentRect.height, root.scrollHeight].join(':');
      unchangedFrames = current === previous ? unchangedFrames + 1 : 0;
      previous = current;
      if (window.__PERF_RESIZES__.length > resizeStart && unchangedFrames >= 1) {
        resolve({ contentStableTs: performance.now(), contentChannelId: channelId, contentKind });
        return;
      }
      if (observedFrames >= 120) {
        reject(new Error('ResizeObserver did not report stable message geometry'));
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
})()
`

interface DrainedSwitch {
  clickTs: number
  skeletonTs: number | null
  paintedTs: number | null
  contentStableTs: number | null
  contentChannelId: string | null
  contentKind: "messages" | "empty" | null
  resizes: number[]
  resources: CapturedSwitch["resources"]
  commits: CapturedSwitch["commits"]
  unmounts: string[]
  layoutShifts: CapturedSwitch["layoutShifts"]
  degraded: boolean
}

async function drainSwitch(page: Page, sinceTs: number, markName: string, stable: PerfStableTarget | null): Promise<DrainedSwitch> {
  return page.evaluate(
    ({ sinceTs, markName, stable }) => {
      const marks = performance.getEntriesByName(markName, "mark")
      const clickTs = marks.length ? marks[marks.length - 1].startTime : sinceTs

      const events = (window.__ALOOK_PERF__ || []).filter((e) => e.ts >= clickTs)
      const commits = events
        .filter((e) => e.kind === "commit")
        .map((e) => {
          const fibers = e.fibers || []
          const mkReason = (f: {
            changedProps?: string[] | null
            changedByParent?: boolean
            changedHooks?: number[]
            changedState?: boolean
            changedContext?: boolean
          }) => {
            const parts: string[] = []
            if (f.changedProps && f.changedProps.length) parts.push("props:[" + f.changedProps.join(",") + "]")
            if (f.changedByParent) parts.push("parent")
            if (f.changedHooks && f.changedHooks.length) parts.push("hooks")
            if (f.changedState) parts.push("state")
            if (f.changedContext) parts.push("context")
            return parts.join("+") || undefined
          }
          const proj = (f: NonNullable<typeof e.fibers>[number]) => ({
            name: f.name,
            fiberId: f.fiberId,
            actualDuration: f.actualDuration,
            reason: mkReason(f),
          })
          return {
            ts: e.ts,
            kind: e.kind,
            mounts: fibers.filter((f) => f.isFirstMount === true).map(proj),
            rerenders: fibers.filter((f) => f.isFirstMount === false).map(proj),
          }
        })
      const unmounts = events
        .filter((e) => e.kind === "fiber-unmount")
        .map((e) => e.componentName || "unknown")

      const resources = (window.__PERF_RESOURCES__ || []).filter((r) => r.startTime >= clickTs)
      const layoutShifts = (window.__PERF_SHIFTS__ || []).filter((s) => s.ts >= clickTs)
      const resizes = (window.__PERF_RESIZES__ || []).filter((t) => t >= clickTs)
      const contentStableTs = stable?.contentStableTs ?? null

      return {
        clickTs,
        skeletonTs: window.__PERF_SKELETON_TS__ ?? null,
        paintedTs: window.__PERF_PAINTED_TS__ ?? null,
        contentStableTs,
        contentChannelId: stable?.contentChannelId ?? null,
        contentKind: stable?.contentKind ?? null,
        resizes,
        resources,
        commits,
        unmounts,
        layoutShifts,
        degraded: window.__ALOOK_PERF_DEGRADED__ === true,
      }
    },
    { sinceTs, markName, stable },
  )
}

test("community switch perceived-latency capture", async ({ browser }) => {
  const manifest = loadManifest()
  expect(manifest.servers.length, "seed manifest has servers").toBeGreaterThan(0)
  const targetServer = manifest.servers.find((s) => s.channels.length >= 5) ?? manifest.servers[0]
  const channels = targetServer.channels.slice(0, 6)
  expect(channels.length, "target server has channels").toBeGreaterThan(1)

  const context = await browser.newContext()
  await authenticateAs(context, manifest.owner.email)
  const page = await context.newPage()

  // Precondition guards.
  expect(process.env.NEXT_PUBLIC_MOCK_NETWORK, "mock-network must be off").not.toBe("true")

  await page.goto(`${BASE_URL}/c/channels/${targetServer.id}`, { waitUntil: "commit" })
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith(`/c/channels/${targetServer.id}/`) &&
      url.pathname !== `/c/channels/${targetServer.id}/`,
    { timeout: 20_000 },
  )
  // Prove the react-scan hook registered early enough: commit events must
  // actually arrive (not merely that hooks are "available").
  await page.waitForFunction(() => Array.isArray(window.__ALOOK_PERF__) && window.__ALOOK_PERF__.length > 0, undefined, {
    timeout: 20_000,
  })
  const degraded = await page.evaluate(() => window.__ALOOK_PERF_DEGRADED__ === true)
  expect(degraded, "react-scan profiling hooks live").toBe(false)

  // Warm the LEAF routes (channel + server) so first-hit dev compile isn't
  // misattributed to a measured switch.
  const firstLeaf = `${BASE_URL}/c/channels/${targetServer.id}/${channels[0].id}`
  if (page.url() !== firstLeaf) {
    await page.goto(firstLeaf, { waitUntil: "commit" })
  }
  await page.waitForSelector("[data-msg-id]", { timeout: 20_000 })

  const captured: CapturedSwitch[] = []
  const warmReloadCapture: { current?: CapturedWarmReload } = {}
  const startedAt = new Date().toISOString()

  async function measureSwitch(
    kind: SwitchKind,
    targetId: string,
    cacheState: CacheState,
    navigate: () => Promise<void>,
  ): Promise<void> {
    const target: PerfTarget = { serverId: kind === "server" ? targetId : targetServer.id,
      ...(kind === "channel" ? { channelId: targetId } : {}), messageScrollerId: tid.messageScroller }
    await page.evaluate(INPAGE_SETUP)
    await page.evaluate(target => {
      window.__PERF_SKELETON_TS__ = null
      window.__PERF_PAINTED_TS__ = null
      if (!window.__PERF_ATTACH_RESIZE__) throw new Error("Missing perf resize collector")
      window.__PERF_ATTACH_RESIZE__(target)
    }, target)
    const markName = `alook:switch:${kind}:${targetId}`
    const t0 = await page.evaluate(() => performance.now())
    const capture = async (stable: PerfStableTarget | null) => {
      const drained = await drainSwitch(page, t0, markName, stable)
      captured.push({ kind, targetId, cacheState, ...drained })
      flushCapture()
    }
    let stable: PerfStableTarget
    try {
      await navigate()
      const painted = await page.waitForFunction(samplePerfTarget, target, { timeout: 25_000 })
      await painted.dispose()
      stable = await page.evaluate(async target => {
        if (!window.__PERF_ATTACH_RESIZE__ || !window.__PERF_WAIT_FOR_STABLE_RESIZE__) throw new Error("Missing perf stability sampler")
        if (!window.__PERF_ATTACH_RESIZE__(target)) throw new Error("Target content disappeared before stability sampling")
        return window.__PERF_WAIT_FOR_STABLE_RESIZE__(target)
      }, target)
    } catch (error) {
      try { await capture(null) } finally { throw error }
    }
    await capture(stable)
  }

  function flushCapture(): void {
    const out: CaptureFile = {
      owner: manifest.owner,
      createdAt: startedAt,
      switches: captured,
      ...(warmReloadCapture.current ? { warmReload: warmReloadCapture.current } : {}),
    }
    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    writeFileSync(CAPTURE_OUT, JSON.stringify(out, null, 2))
  }

  const persistedKey = `${PERSIST_CACHE_PREFIX}:${manifest.owner.userId}:client`
  const clearQueryPayload = () => page.evaluate(operatePerfQueryCache, { key: persistedKey, action: "remove" as const })

  // Matrix size is env-configurable and defaults SMALL: against a live Next dev
  // build each switch costs full API fan-out + paint + reflow settle (often
  // 1-3s), so a big matrix blows any practical timeout. The incremental
  // flushCapture() means even a partial run yields a report; bump these when
  // pointing at a faster (prod) build. See the harness header.
  const N_CHANNEL = Number(process.env.PERF_CHANNEL_SWITCHES ?? 3)
  const N_SERVER = Number(process.env.PERF_SERVER_SWITCHES ?? 3)

  // --- Channel switches: cold, then memory-warm (immediate repeat) ---
  for (let i = 1; i < Math.min(channels.length, N_CHANNEL + 1); i++) {
    const ch = channels[i]
    await clearQueryPayload()
    await measureSwitch("channel", ch.id, "cold", async () => {
      await page.getByTestId(tid.channelRow(ch.id)).click()
    })
    // memory-warm: click away and back within staleTime.
    const prev = channels[i - 1]
    await page.getByTestId(tid.channelRow(prev.id)).click()
    await page.waitForURL(new RegExp(`/c/channels/${targetServer.id}/${prev.id}$`), {
      waitUntil: "commit",
    })
    await expect(page.getByTestId(tid.messageScroller).locator("[data-msg-id]").first()).toBeVisible()
    await measureSwitch("channel", ch.id, "memory-warm", async () => {
      await page.getByTestId(tid.channelRow(ch.id)).click()
    })
  }

  // --- disk-warm channel pass: let the app persist to IDB, reload preserving
  // it, then measure the first switch (messages paint from disk, read-state
  // still refetches). ---
  const diskChannel = channels[1]
  await page.getByTestId(tid.channelRow(channels[0].id)).click()
  await page.waitForURL(firstLeaf, { waitUntil: "commit" })
  await expect(page.getByTestId(tid.messageScroller).locator("[data-msg-id]").first()).toBeVisible()
  await expect.poll(() => page.evaluate(operatePerfQueryCache, {
    key: persistedKey,
    action: "contains" as const,
    version: PERSIST_VERSION,
    buster: PERSIST_BUSTER,
    queryKey: communityKeys.communityDbCollection(manifest.owner.userId, "messages"),
    channelIds: [channels[0].id, diskChannel.id],
  })).toBe(true)
  await page.addInitScript(() => {
    window.__PERF_WARM_RELOAD__ = { customBootstrapSeen: false, skeletonSeen: false }
    const inspect = () => {
      const capture = window.__PERF_WARM_RELOAD__
      if (!capture) return
      if (document.querySelector('[data-slot="community-restore-bootstrap"]')) {
        capture.customBootstrapSeen = true
      }
      if (
        document.querySelector('[aria-label="Loading community"]')
        || document.querySelector('[data-slot="skeleton"]')
      ) capture.skeletonSeen = true
    }
    new MutationObserver(inspect).observe(document, { childList: true, subtree: true })
    inspect()
  })
  await page.reload({ waitUntil: "commit" })
  await page.waitForSelector("[data-msg-id]", { timeout: 20_000 })
  warmReloadCapture.current = await page.evaluate(() => {
    const latestMark = (name: string) => {
      const marks = performance.getEntriesByName(name, "mark")
      return marks.at(-1)?.startTime ?? null
    }
    const restoreStartTs = latestMark("alook:restore:start")
    const restoreCompleteTs = latestMark("alook:restore:complete")
    const firstCachedPaintTs = latestMark("alook:restore:first-cached-paint")
    const stableTs = latestMark("alook:restore:stable")
    if (
      restoreStartTs == null
      || restoreCompleteTs == null
      || firstCachedPaintTs == null
      || stableTs == null
    ) throw new Error("warm reload restore lifecycle marks are incomplete")
    return {
      restoreStartTs,
      restoreCompleteTs,
      firstCachedPaintTs,
      stableTs,
      customBootstrapSeen: window.__PERF_WARM_RELOAD__?.customBootstrapSeen === true,
      skeletonSeen: window.__PERF_WARM_RELOAD__?.skeletonSeen === true,
    }
  })
  const warmReload = warmReloadCapture.current
  expect(warmReload.customBootstrapSeen, "warm reload omitted the custom restore bootstrap").toBe(false)
  expect(warmReload.skeletonSeen, "warm reload reused the route-owned regional skeleton").toBe(true)
  expect(warmReload.restoreCompleteTs).toBeGreaterThanOrEqual(warmReload.restoreStartTs)
  expect(warmReload.firstCachedPaintTs).toBeGreaterThanOrEqual(warmReload.restoreCompleteTs)
  expect(warmReload.stableTs).toBeGreaterThanOrEqual(warmReload.firstCachedPaintTs)
  flushCapture()
  {
    await measureSwitch("channel", diskChannel.id, "disk-warm", async () => {
      await page.getByTestId(tid.channelRow(diskChannel.id)).click()
    })
  }

  // --- Server switches (cold) ---
  const otherServers = manifest.servers.filter((s) => s.id !== targetServer.id).slice(0, N_SERVER)
  for (const srv of otherServers) {
    await clearQueryPayload()
    await measureSwitch("server", srv.id, "cold", async () => {
      await page.getByTestId(tid.serverIcon(srv.id)).click()
    })
  }

  flushCapture() // final flush (measureSwitch already flushes incrementally)
  expect(captured.length, "captured at least one switch").toBeGreaterThan(0)
  await context.close()
})
