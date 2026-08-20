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
 * See plans/community-switch-perf-diagnosis.md. LOCAL-ONLY — runs via
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
import type {
  CacheState,
  CaptureFile,
  CapturedSwitch,
  SwitchKind,
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

// In-page instrumentation installed before each measured switch. Reads the
// react-scan ring buffer + performance marks + resource timings + a
// ResizeObserver on the message scroll container, all on the browser clock.
const INPAGE_SETUP = `
(() => {
  if (window.__PERF_RESOURCE_OBSERVER__) window.__PERF_RESOURCE_OBSERVER__.disconnect();
  if (window.__PERF_LAYOUT_OBSERVER__) window.__PERF_LAYOUT_OBSERVER__.disconnect();
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
  window.__PERF_RESOURCE_OBSERVER__ = ro;
  ro.observe({ type: 'resource', buffered: true });
  const lo = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      // KEEP hadRecentInput entries — the click-triggered reflow is exactly what
      // standard CLS filtering drops, and it's what we're measuring.
      window.__PERF_SHIFTS__.push({ ts: e.startTime, value: e.value, hadRecentInput: e.hadRecentInput });
    }
  });
  window.__PERF_LAYOUT_OBSERVER__ = lo;
  try { lo.observe({ type: 'layout-shift', buffered: true }); } catch (_) {}
  // Attach a ResizeObserver to the message scroll container. The container is
  // persistent, but on a cold switch it may be re-created (React swaps the
  // subtree), so a once-only global guard would leave the observer watching a
  // detached node and never fire again — hence NO cross-switch guard here, and
  // we disconnect the prior observer before re-observing the current root.
  window.__PERF_ATTACH_RESIZE__ = () => {
    const root = document.querySelector('.thin-scrollbar');
    if (!root) return false;
    if (window.__PERF_RESIZE_OBSERVER__) window.__PERF_RESIZE_OBSERVER__.disconnect();
    const rz = new ResizeObserver(() => { window.__PERF_RESIZES__.push(performance.now()); });
    rz.observe(root);
    window.__PERF_RESIZE_OBSERVER__ = rz;
    return true;
  };
})()
`

interface DrainedSwitch {
  clickTs: number
  skeletonTs: number | null
  paintedTs: number | null
  contentStableTs: number | null
  resources: CapturedSwitch["resources"]
  commits: CapturedSwitch["commits"]
  unmounts: string[]
  layoutShifts: CapturedSwitch["layoutShifts"]
  degraded: boolean
}

async function drainSwitch(page: Page, sinceTs: number, markName: string): Promise<DrainedSwitch> {
  return page.evaluate(
    ({ sinceTs, markName }) => {
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
      const contentStableTs = resizes.length ? resizes[resizes.length - 1] : null

      return {
        clickTs,
        skeletonTs: window.__PERF_SKELETON_TS__ ?? null,
        paintedTs: window.__PERF_PAINTED_TS__ ?? null,
        contentStableTs,
        resources,
        commits,
        unmounts,
        layoutShifts,
        degraded: window.__ALOOK_PERF_DEGRADED__ === true,
      }
    },
    { sinceTs, markName },
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
  await page.waitForFunction(() => Array.isArray(window.__ALOOK_PERF__) && window.__ALOOK_PERF__.length > 0, {
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
  await page.waitForSelector("[data-msg-id]", { timeout: 20_000 }).catch(() => {})

  const captured: CapturedSwitch[] = []
  const startedAt = new Date().toISOString()

  async function measureSwitch(
    kind: SwitchKind,
    targetId: string,
    cacheState: CacheState,
    navigate: () => Promise<void>,
  ): Promise<void> {
    await page.evaluate(INPAGE_SETUP)
    await page.evaluate(() => {
      window.__PERF_SKELETON_TS__ = null
      window.__PERF_PAINTED_TS__ = null
      window.__PERF_ATTACH_RESIZE__?.()
    })
    const markName = `alook:switch:${kind}:${targetId}`
    const t0 = await page.evaluate(() => {
      window.__ALOOK_PERF__ = []
      return performance.now()
    })

    await navigate()

    // Record skeleton + painted anchors as they appear. Both are captured in
    // ONE polling loop so whichever DOM state shows first stamps its own
    // timestamp: the message-list loading state renders `[data-slot=skeleton]`
    // in the scroll container, then swaps to `[data-msg-id]` rows once loaded.
    // A memory/disk-warm switch can paint rows with no skeleton frame at all,
    // so skeleton stays null there (correctly — there was no loading spell).
    await page
      .waitForFunction(
        () => {
          // Scope the skeleton probe to the message scroll container — a bare
          // `[data-slot=skeleton]` also matches sidebar/member-list skeletons
          // elsewhere on the page (and leftovers from the prior switch), which
          // stamped a bogus 16ms skeleton on memory-warm switches that have no
          // loading spell at all.
          if (
            window.__PERF_SKELETON_TS__ == null &&
            document.querySelector(".thin-scrollbar [data-slot='skeleton']")
          ) {
            window.__PERF_SKELETON_TS__ = performance.now()
          }
          const painted = document.querySelector("[data-msg-id]")
          if (painted && window.__PERF_PAINTED_TS__ == null) {
            window.__PERF_PAINTED_TS__ = performance.now()
          }
          return window.__PERF_PAINTED_TS__ != null
        },
        { timeout: 25_000 },
      )
      .catch(() => {})

    // Re-attach the ResizeObserver to the CURRENT scroll container. Attaching
    // once before navigate() misses cold switches where React re-creates the
    // container after the click, leaving the pre-switch observer on a detached
    // node — the bug that left contentStableTs perpetually null.
    await page.evaluate(() => window.__PERF_ATTACH_RESIZE__?.())

    // Let reflow settle so the ResizeObserver captures content-stable.
    await page.waitForTimeout(600)

    const drained = await drainSwitch(page, t0, markName)
    captured.push({ kind, targetId, cacheState, ...drained })
    // Write incrementally so a timed-out / interrupted run still yields a
    // usable capture the report generator can consume (dev-build latency can
    // blow any single wall-clock budget — see the harness header).
    flushCapture()
  }

  function flushCapture(): void {
    const out: CaptureFile = {
      owner: manifest.owner,
      createdAt: startedAt,
      switches: captured,
    }
    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    writeFileSync(CAPTURE_OUT, JSON.stringify(out, null, 2))
  }

  // Force a cold pass by clearing the persister's IndexedDB. Do NOT
  // `deleteDatabase` — the app holds an open connection to `keyval-store`, so
  // the delete request fires `onblocked` and can hang indefinitely. Instead
  // clear the object store's CONTENTS (a transaction that doesn't need the DB
  // closed), with a hard timeout so a switch can never wedge the whole run.
  async function clearIdb(): Promise<void> {
    await page.evaluate(
      () =>
        new Promise<void>((res) => {
          const done = setTimeout(res, 3000) // never wedge the run
          const open = indexedDB.open("keyval-store")
          open.onerror = () => {
            clearTimeout(done)
            res()
          }
          open.onsuccess = () => {
            const db = open.result
            if (!db.objectStoreNames.contains("keyval")) {
              db.close()
              clearTimeout(done)
              res()
              return
            }
            const tx = db.transaction("keyval", "readwrite")
            tx.objectStore("keyval").clear()
            tx.oncomplete = tx.onerror = () => {
              db.close()
              clearTimeout(done)
              res()
            }
          }
        }),
    )
  }

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
    await clearIdb()
    await measureSwitch("channel", ch.id, "cold", async () => {
      await page.getByTestId(`community-channel-row-${ch.id}`).click()
    })
    // memory-warm: click away and back within staleTime.
    const prev = channels[i - 1]
    await page.getByTestId(`community-channel-row-${prev.id}`).click()
    await page.waitForTimeout(200)
    await measureSwitch("channel", ch.id, "memory-warm", async () => {
      await page.getByTestId(`community-channel-row-${ch.id}`).click()
    })
  }

  // --- disk-warm channel pass: let the app persist to IDB, reload preserving
  // it, then measure the first switch (messages paint from disk, read-state
  // still refetches). ---
  await page.waitForTimeout(1500) // let the throttled persist settle
  await page.reload({ waitUntil: "commit" })
  await page.waitForSelector("[data-msg-id]", { timeout: 20_000 }).catch(() => {})
  {
    const ch = channels[1]
    await measureSwitch("channel", ch.id, "disk-warm", async () => {
      await page.getByTestId(`community-channel-row-${ch.id}`).click()
    })
  }

  // --- Server switches (cold) ---
  const otherServers = manifest.servers.filter((s) => s.id !== targetServer.id).slice(0, N_SERVER)
  for (const srv of otherServers) {
    await clearIdb()
    await measureSwitch("server", srv.id, "cold", async () => {
      await page.getByTestId(`community-server-icon-${srv.id}`).click()
    })
  }

  flushCapture() // final flush (measureSwitch already flushes incrementally)
  expect(captured.length, "captured at least one switch").toBeGreaterThan(0)
  await context.close()
})
