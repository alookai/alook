# Independent browser benchmark

A manual tool for measuring real user operations against an already running application. It owns its Node/Playwright dependencies and imports no Alook product code. Copy this directory outside the repository to run it. Neither workspace tests nor CI invoke its scenarios.

The first journey uses a 100-member top-level text channel and two real user pages in one Chromium instance. The sender types and presses Enter; both pages must show the same message in the viewport. API-only measurements are available as supporting protocol calibration, not as the user-operation result.

## Install and run

```sh
cd src/benchmark
npm ci
npx playwright install chromium
cp example.config.json run.local.json
node src/cli.mjs run run.local.json
```

Record the exact product SHA and environment/build description in the config. The browser's WS endpoint comes from the real application's configuration; `wsUrl` is used only by protocol calibration. Disable the product's mock network when building the target. The target requires its ordinary migrations, local bindings and authentication configuration.

Supply a dedicated credential fixture, never commit or upload it:

```json
{
  "serverId": "dedicated-server-id",
  "channelId": "dedicated-channel-id",
  "accounts": [
    { "userId": "sender-id", "cookie": "AUTHENTICATION_COOKIES" },
    { "userId": "receiver-id", "cookie": "AUTHENTICATION_COOKIES" }
  ]
}
```

Use authenticated accounts with onboarding already handled. Export authentication cookies, not one-time signup markers that restart onboarding on every fresh context. The first account sends and the second receives. Membership APIs verify exactly `expectedMembers` visible members and access for both measured users; 100 members does not mean 100 online browser pages.

For fresh local fixtures, `accounts LOCAL_URL FIXTURE [COUNT]` calls the public signup API with `BENCHMARK_PASSWORD` from the environment. It saves credentials with mode 0600 and omits the one-time signup marker. `setup CONFIG` creates a server/channel and joins all accounts through public APIs. These preparations are outside timing and are not product performance measurements. Existing server/channel references are never overwritten; test data is not automatically deleted.

The browser driver navigates to the configured public route, waits for the actual page WS authentication and composer, and uses the visible scroll-to-present control until the page reaches the latest messages. It fills the composer before timing. It never calls product stores, mutation functions or internal UI helpers. Selectors, route templates and `submitAction: "enter" | "click"` can be supplied through `scenario`; defaults describe Alook's public DOM. Desktop Alook uses Enter by default.

## Native, diagnostic and delay runs

The example is a native observation run: `observeDB: false`, one baseline phase with zero delay. HTTP/WS are observed passively; no routing is installed, so the tool does not disable HTTP cache. Both modes block service workers to ensure the page network is observable; this browser setting is recorded and is a limitation for service-worker-dependent journeys.

For D1 diagnostics, set `observeDB: true` and use the optional adapter below. For delay calibration, specify:

```json
"phases": [
  { "name": "baseline", "phase": "request", "delayMs": 0 },
  { "name": "request-delay", "phase": "request", "delayMs": 1000 },
  { "name": "response-delay", "phase": "response", "delayMs": 1000 }
]
```

Only the sender's message POST is delayed. Request delay waits before forwarding; response delay waits after the upstream response. WS and other requests are not delayed. Actual waits are recorded. A receiver may see the message before the delayed response arrives; the local optimistic row need not wait for either delay.

Any DB-header or delay run uses Playwright routing, which disables HTTP cache for the context. Reports explicitly identify `intercepted-cache-disabled` versus `passive-native-cache`; the comparator refuses to mix these modes. Compare observer-on/off or delayed/undelayed runs as calibration evidence, not as product version improvement. The target's normal entry and bundle contain no benchmark instrumentation; the optional wrapper is selected only by a dedicated runtime command.

## Recorded observations

- **Submit:** trusted real keydown/click received by the control. Preparation and filling are outside this timestamp.
- **Sender/receiver DOM visible:** the uniquely marked message intersects the viewport, is not hidden/transparent or clipped away, and the document is visible. An optimistic local row is distinguished from its canonical replacement. Real ID reconciliation is a diagnostic, not a visible delivery receipt.
- **Next animation frame:** separate callback after DOM visibility; it does not prove physical display paint. Each page uses `performance.timeOrigin + performance.now()` in the same browser instance. Node/HTTP timestamps additionally carry min-RTT clock calibration and its uncertainty.
- **Network:** HTTP request bodies, decoded response bodies, and WS application frames. Direct message requests are separated from other operations observed in the window. IDs/nonces link API, WS and DOM; raw bodies, tokens and message text are not logged. A shared WS frame is counted once in window bytes. No TLS, headers or physical wire size is claimed.
- **Resources:** CDP `threadTicks` task/script/layout duration deltas for each page's main thread, plus JS heap before/after. CPU sampling brackets probe arm through DOM freeze and includes driver/probe and concurrent work. This is not total browser/process CPU or server CPU.

The observation window starts just before the real action. It lasts at least `observationWindowMs` and can extend while waiting for the visible endpoints, bounded by action/visibility timeouts. DOM observations freeze at cutoff. HTTP records at cutoff remain immutable; later body completions are retained separately in raw requests and do not backfill window totals. Unfinished requests, failures, duplicates, WS disconnections and missing observations remain explicit. A quiet/fixed window does not prove all background work completed.

Warmups are retained but excluded from summaries. Success percentiles exclude failed attempts; failed attempts remain in the denominator and failed HTTP timing has its own field. Nearest-rank p50/p95 use available observations; small-sample tails are exploratory. Serial closed-loop operations include the observation window and configured pacing, so injected runs may have lower offered load.

## Optional generic Worker/D1 adapter

The runner itself works without this adapter and reports DB as unknown. Generate an independent entry around a target's normal Worker entry:

```sh
node src/benchmark/src/cli.mjs adapter src/web/custom-worker.ts src/benchmark/.runtime/worker.mjs
pnpm exec wrangler dev src/benchmark/.runtime/worker.mjs \
  --config src/web/wrangler.toml --config src/ws-do/wrangler.toml \
  --config src/queue-worker/wrangler.toml --local --port 3000 \
  --inspector-port 9237 --persist-to src/web/.wrangler/state \
  > /tmp/benchmark-worker.log 2>&1
```

Run this from the target repository after building its ordinary OpenNext artifact. These are example local target-launch commands, not imports required by this package or deployment instructions. Match the target's migration and runtime persistence paths. Regenerate the adapter after moving its absolute paths. If services share ingress 3000, configure the target's local WS URL/port accordingly.

Only requests carrying valid benchmark IDs activate the wrapper. It preserves fetch responses, D1 return values, session/bookmarks, atomic batches and tracked `waitUntil` tasks. Join captured records after the run:

```sh
node src/cli.mjs report artifacts/trace-run /tmp/benchmark-worker.log
```

D1 execution calls and submitted statements are different: batch is one call with N submitted statements, including failed batches without assuming all succeeded. `exec` retains its runtime-reported count separately; submitted SQL statement count remains unknown because that count is not a portable statement parser. Prepare/bind/session construction are not executions.

Rows read/written, SQL duration and internal attempts come only from actual metadata. `raw()`/`first()` supply no metadata: the adapter never issues extra queries or substitutes `all()`. Reports show known partial totals and coverage. Trigger/batch rollback behavior is calibrated against real local D1. Auth/schema introspection is real observed cost; it must not be mislabeled as message writes.

SQL UTF-8, bound-value JSON and result JSON logical bytes are separate. Binary data uses `{"binaryBase64":"..."}`; unsupported JSON values yield unknown sizes. No SQL, values or results are emitted. These counts do not measure D1 physical page I/O or transport bytes. The wrapper itself has measurement overhead.

Coverage is **web env.DB only**. WS DO server resources, queue consumers, other bindings, server CPU/RSS and physical I/O remain unknown. A web completion closes only that invocation's tracked tasks. Background calls starting or crossing the response remain identified. Completion records include the actual D1 execution count: fully closed requests with an explicit zero count report zero cost; missing execution logs or older completion records without that count cannot prove zero. Duplicate logs are deduplicated; conflicting observations fail report generation. Share filtered `db.jsonl`, never raw target logs or fixture credentials.

## Compare and verify

```sh
node src/cli.mjs compare artifacts/base artifacts/head
```

Use the same fixture scale, browser, environment, tool source digest, scenario, viewport, observation mode, payloads, samples, warmup and pacing. Change `targetVersion` to the actual target commit. The comparator refuses incompatible contracts; it emits absolute values, deltas and percentages, with null percentage for zero baseline. Partial DB costs retain coverage; differing coverage prevents a conclusion about total cost. A/A runs are repeatability controls, not optimization evidence.

Each browser run creates metadata, `operations.jsonl`, first/last and prepared-page screenshots, JSON and Markdown summaries. Report rebuilding adds `db.jsonl`; comparison adds JSON/Markdown to the head directory. Every run requires an empty output directory. Inspect screenshots and IDs to verify that the measured page content matches the operation. Interrupted runs lack `finishedAt` and are incomplete.

Dedicated tool checks (not product test/CI integration):

```sh
npm run check
node test/browser-probe.control.mjs
```

The probe control verifies trusted input, replacement of an optimistic node before the next frame, frozen observations, and hidden/offscreen exclusion. `test/d1-control-worker.mjs` is a manual actual-D1 control target for trigger, batch rollback, raw columns and first() behavior. `calibrate CONFIG` retains the API/WS/history runner and 0/1000ms proxy for supporting protocol calibration; its `samples.jsonl` report is never the primary user journey.

References: [Playwright routing/cache](https://playwright.dev/docs/api/class-browsercontext#browser-context-route), [High Resolution Time](https://www.w3.org/TR/hr-time-3/), [D1 metadata](https://developers.cloudflare.com/d1/worker-api/return-object/).
