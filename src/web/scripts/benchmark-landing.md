# Homepage browser benchmark

Use a production build and a dedicated local server. No production requests or new dependencies are needed.

```sh
pnpm build
pnpm exec next start --hostname 127.0.0.1 --port 3026
```

In another shell, from `src/web`, warm the server separately, then measure fresh browser caches:

```sh
curl -s -o /dev/null http://127.0.0.1:3026/
BENCH_RUNS=10 BENCH_LATENCY_MS=40 BENCH_DOWNLOAD_MBPS=100 BENCH_BUDGET_MS=300 node scripts/benchmark-landing.mjs
```

The report and first-run screenshots go to `.alook-qa-scratch/landing-benchmark/` (ignored). Set `BENCH_OUTPUT` to retain separate runs. `BENCH_URL` accepts localhost only. Reports contain build ID, machine, Chromium version, network/CPU settings and every sample.

- `firstScreen`: max(FCP, observed LCP, hero asset/font readiness). Hero readiness includes the fixed photos that animate into view later; it is deliberately stricter than initial paint. It does not wait for every entrance animation to finish or prove all interactions are ready.
- FCP/LCP are reported separately: earlier asset readiness is not necessarily earlier visible text.
- Desktop 1440×900 and mobile-sized 390×844 use the same host CPU, DPR 1 and light theme. This is not physical phone testing. `BENCH_CPU_RATE=4` adds simulated CPU slowdown.
- Each run uses a fresh browser context, followed by a warm-cache visit in that context. Server/module warmup is separate from browser cold cache. Do not describe warmed-server results as process cold starts.
- GTM, GA and Grafana requests are blocked. Service workers are blocked. First-party HTTP errors and page JavaScript errors fail the run.
- CDP simulates the configured latency and bandwidth on loopback. It does not reproduce internet DNS, TLS, edge placement or real users. Report the settings with the result.

Repeat with `BENCH_DOWNLOAD_MBPS=10` for the slower-network case. Keep its results separate; passing at 100 Mbps does not imply passing at 10 Mbps. With `BENCH_BUDGET_MS`, any profile/cache p95 at or above the budget exits nonzero after writing the report. Omit the budget for investigation.

`next start` also loads this repository's development Cloudflare adapter from `next.config.ts`. A fresh Node process therefore includes local emulator initialization; that timing is not a production Worker cold-start estimate.
