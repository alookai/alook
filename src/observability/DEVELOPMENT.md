# Local Faro observations

Run `pnpm dev` or `pnpm dev:web` from the repository root. The Web development owner applies the local receiver migrations, starts one receiver, waits for its own health identity, and then starts the normal main and Blog frontends. Open the printed **Alook local observations** URL (normally `http://127.0.0.1:4318`). Allow analytics in the local Alook app, navigate, then select **Refresh list** in the viewer.

The receiver is a repository-owned Cloudflare Worker with local D1 and static browser assets. There is no native viewer download, global installation, Docker requirement, remote database or deployment step. Existing custom Faro data is the only input. Native Worker logs/traces are outside this service.

## Inspect data

- Select a trace to inspect its waterfall, parent relationships, attributes, events, links and individual raw spans. Use **Refresh selected trace** to reload that trace; refreshing the list preserves the current waterfall.
- **All logs & measurements** includes records without trace references. Trace details show only logs with native or explicit `event.attributes.trace_id` references. These two reference sources stay separate, including when they disagree. No relationship is inferred from time proximity.
- **Download original received batch** returns the exact original UTF-8 JSON, which can contain other traces. The waterfall receives a selected-trace projection with its original resource/scope context and current retained span records.
- Page-instance and session filters are exact matches. The list shows at most100 rows. A trace detail view is bounded to5000 spans and8MiB of distinct original batch data; partial views show the reason.

Native decimal-string nanosecond times and span durations remain intact. Numeric timestamps emitted by the official Faro log converter retain the precision actually sent; the receiver cannot restore precision already absent from that sender. **Trace extent** covers every retained span and can extend past navigation readiness, for example for a later WebSocket child. Read the document/navigation span's own fields for those timings.

## Lifecycle and isolated ports

The owner stops its receiver when the app stops. Unexpected receiver exit stops its managed frontend children. Startup failure and cancellation clean up only owned process groups. Each native child has an IPC supervisor, so parent interruption closes that channel and retires the child's group even if Turbo stops the launcher before its asynchronous cleanup finishes. The parent retains native-group ownership until retirement is confirmed. An occupied receiver or inspector port is refused; the existing listener is left running. Each checkout has its own `.wrangler/registry` and receiver D1 state at `src/observability/.wrangler/state`.

For an isolated normal multi-zone run:

```sh
ALOOK_DEV_PORT=9540 ALOOK_DEV_MAIN_PORT=9541 ALOOK_DEV_BLOG_PORT=9542 ALOOK_OBSERVABILITY_PORT=9538 pnpm dev:web
```

`ALOOK_OBSERVABILITY_INSPECTOR_PORT` optionally selects a separate free inspector port; its default0 lets the runtime allocate one. `ALOOK_OBSERVABILITY_PERSIST_TO` selects a receiver state directory relative to the repository root, or an absolute directory. These variables pass through Turbo's development environment filtering. Normal Worker/phase validation entrypoints keep their existing behavior and do not start this receiver.

`pnpm --filter @alook/web dev:main` and `dev:blog` also start their own managed receiver. Use the multi-zone command to run both together. Independent owners must use different ports and state directories.

Run `pnpm dev:observability` to inspect retained data without starting Alook. This is a standalone owner, so stop it before using its same port for a managed app run, or choose another port explicitly. Data survives receiver restart. Stop commands do not delete retained data.

## Input and storage contract

The official `@grafana/faro-transport-otlp-http`2.12.1 sends JSON to `/v1/traces` and `/v1/logs`. Development selects a clean explicit HTTP loopback origin. Production retains the existing HTTPS Faro transport, sampling and sanitization. Consent withdrawal, account/session retirement and lifecycle suspension still abort the admitted transport generation. Requests omit credentials, and both local endpoints are excluded from HTTP instrumentation.

The receiver acknowledges an ingest only after the original batch, scoped indexes and retention changes commit atomically. Original text is stored once. Trace/span IDs upsert the newest received pointer; logs preserve each received record. A batch is limited to1MiB,2000 records and1.5MiB of derived indexes. Retention keeps at most64MiB of raw batches,200 batches and50,000 received records. Removing an old batch cascades only its still-owned indexes. All persistence belongs to local D1 rather than process memory.

Only loopback hosts are served. Ingest permits explicit HTTP/HTTPS loopback origins without credentials. Query and raw-payload reads remain same-origin. Errors and truncation are visible; an HTTP transport attempt is not evidence of persisted acceptance. The service supports the actual Faro JSON contract, not protobuf or gRPC. Leading UTF-8 BOM input is rejected as invalid JSON rather than silently removing its bytes.

## Source and checks

The MIT waterfall is pinned to `distributed-tracing-request-correlation/trace-waterfall-viewer` commit `27adfa3e0d46039bae9a684f88cea542b847b134`. Its exact20 upstream files and license are under `public/vendor/trace-waterfall-viewer`, with byte counts, Git blob IDs and SHA256 in `upstream-manifest.json`. The owned HTML adapter replaces the upstream bootstrap once; it does not modify vendor source or build another waterfall. The wrapper's semantic colors follow `src/web/src/app/globals.css`; system font fallbacks apply when the Alook fonts are unavailable.

```sh
pnpm --filter @alook/observability test
pnpm --filter @alook/observability typecheck
pnpm --filter @alook/observability build
```

The build command is a Wrangler dry run. New binding types come from `pnpm --filter @alook/observability cf-typegen`. This package has no deployment script. Runtime/browser acceptance must use the actual source and local service; mocked fetches and process substitutes prove their stated boundaries only.
