# Benchmark changelog

## 2026-09-29 — local message-send baseline

- Target: `6faf39ad9dae75fce3ceec5c27aa51f893e74056` (`origin/main` at run start).
- Run: `704dec12-4e3b-43c3-92e6-83a912eaa06d`, 2026-09-29 15:49:50–15:57:58 UTC+8.
- Case/tool: `channel-message-send` v1, schema 2, tool digest `bae80f19144b861ffb18c58bf33ac767c6c14c9c4e15120a76c6dfa292c5c2d9`.
- Target environment: local Next.js 16.3.6 development server with local D1, WS Durable Object, and queue worker; native passive network/cache; DB observer disabled.
- Runner: Apple M3 Pro (11 logical CPUs, 18 GiB), macOS arm64 23.6.0, Node 22.22.0, headless Chromium 151.0.7922.34, 1440×1000 viewport, service workers blocked.
- Fixture: one public text channel with 100 server/channel members; two real browser pages (one sender and one receiver). Fresh accounts used the same necessary-only analytics-consent cookie as the repository E2E setup so the global banner did not obscure the measured composer/viewport.
- Workload: 5 warmups plus 100 measured serial sends per payload, one receiver, 400 ms pacing, 1800 ms observation window, 15 s timeout.

Latency values are p50 / p95 in milliseconds:

| Content | Attempts / failed | Sender visible | Receiver visible | Sender next frame | Receiver next frame | Direct ACK | Sender reconciled |
|---|---:|---:|---:|---:|---:|---:|---:|
| 64 B | 100 / 0 | 19.4 / 23.3 | 808.7 / 1123.9 | 21.7 / 25.7 | 849.5 / 1159.6 | 320.1 / 501.1 | 319.0 / 500.1 |
| 1024 B | 100 / 0 | 15.4 / 22.0 | 1079.8 / 1735.0 | 18.4 / 30.1 | 1114.2 / 1772.8 | 429.7 / 1029.9 | 428.0 / 1028.1 |

Observed resource values are p50 / p95:

| Content | Sender main-thread CPU ms | Receiver main-thread CPU ms | Direct request B | Direct response B | Window HTTP response B | Window WS application B |
|---|---:|---:|---:|---:|---:|---:|
| 64 B | 178.36 / 227.25 | 228.44 / 287.81 | 125 / 125 | 410 / 411 | 4563 / 17940 | 4075 / 4491 |
| 1024 B | 199.14 / 249.43 | 216.73 / 298.19 | 1085 / 1085 | 1371 / 1371 | 4280 / 5830 | 5791 / 6207 |

Validation and limits:

- All 200 measured operations had a trusted Enter submit, HTTP 201, matching sender/receiver canonical message, exactly one receiver message frame, zero duplicate receiver frames, zero socket closes, and zero collector errors.
- The fixed observation windows ended with 159 unfinished background requests for 64 B and 192 for 1024 B. These remain explicit and are not counted as send failures.
- DB calls, statements, and rows are unknown because this native run did not enable the optional Worker/D1 adapter. Unknown is not zero.
- DOM visibility and next-animation-frame timing do not prove physical display paint. Window HTTP/WS bytes and page CPU include concurrent work and observer overhead.
- Raw local evidence is in the gitignored `src/benchmark/artifacts/2026-09-29-baseline-r2/` directory.
