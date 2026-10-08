# Navigation requests and observation

## Request order and data owners

Next.js owns document/RSC routing and its Router Cache. The account QueryClient owns API de-duplication, cancellation and cache lifetime. The existing community DB publishers own canonical data and enforce account, scope, epoch and access checks.

For a known, accessible DM or server conversation, hover/focus/touch prepares `channelMetadataOptions` on that account's QueryClient. A controller push/replace prepares the same query before calling the router. RSC and metadata can run concurrently; the route joins an in-flight query or its qualified result. This preparation performs no entry, read-state, messages, read ACK, notification clear or primary-ready work. Those operations keep their original route/entry owners. Unknown identities, retired accounts, pending/archived identities and locally revoked access do not use this preparation.

`navigation-metadata.ts` is an eligibility adapter, not a request scheduler. It adds no query keys, response cache, publication path or navigation proof. An existing current `readProof` permits reuse; an unqualified cached resource does not suppress validation. Changing intent does not cancel a shared query owned by another consumer. Account retirement and the query's existing signal/token checks retire its result. A valid metadata result for A belongs only to A's account/scope; it cannot make B ready.

## Authentication

`getAuth` retains the existing immutable BetterAuth instance lifecycle: configuration plus actual Worker version, with a request-local fallback when production version metadata is missing. It never caches headers, sessions or responses.

BetterAuth verifies the signed session/cache cookie and retains its five-minute cache policy. For an authenticated protected request, middleware now forwards BetterAuth's refreshed cookies through NextResponse's request-header override, and returns every original Set-Cookie to the browser. RSC therefore sees the refresh from that same request instead of the old expired cache. No session DTO or bypass flag is forwarded.

The adapter uses BetterAuth's `applySetCookies` and `parseSetCookieHeader`. The locked merge helper does not remove expired cookies; the adapter removes Max-Age <= 0 or expired Expires entries, with Max-Age taking precedence. It preserves signed bytes, chunk names and unrelated incoming cookies. Its input is exclusively this app's BetterAuth getSession response; the current auth cookies use the same host and root path. A future change to cookie domains/paths must requalify this same-request forwarding boundary.

Cookie mutation constructs the NextRequest from the URL and copied headers only. It never passes the original Request or body, clones the stream or adds a reader. The streamed POST regression checks that the original body remains unlocked and readable, the payload is unchanged, and refreshed/deleted cookies still reach the header override. Passing a Request as the constructor input can create a body proxy under the [Fetch Request constructor rules](https://fetch.spec.whatwg.org/#dom-request).

The real BetterAuth/SQLite regression proves a local expired-cache refresh causes one lookup; reading the original stale request headers again causes a second; reading the refreshed headers avoids that second lookup. It also checks valid-cache, absent token, chunk deletion and concurrent account isolation. This is a source regression, not a production D1 latency measurement or revocation-policy change.

## Observation boundaries

| Owner | Evidence | Interpretation |
| --- | --- | --- |
| Navigation action | intent, commit, canonical publication, existing primary ready | The original ready contract remains the endpoint. Shell/skeleton appearance is not completion. |
| Prefetch action | explicit intent and native HTTP children | A pre-click request keeps its original owner. A matching click uses an OTel Link to the actual prefetch SpanContext; it is a new root, not a fabricated parent. |
| API observation | request.start, headers, parsed body, eligibility/publication | `request_id` joins phases; native transport span IDs identify actual HTTP spans after they exist. |
| RSC observation | fetch promise resolution and native SDK body callback | Headers and completed transport body are observable. RSC render/commit is a separate boundary. |
| Worker native tracing | web.request, auth.instance, auth.context_ready, auth.get_session and native D1 children | Native async context owns backend parentage and span lifetime; no second exporter or manual D1 timer is installed. |

The existing context module retains one current explicit prefetch target. An earlier unrelated intent, a router-only speculative request, a Router Cache hit with no network call, or a request started before the SDK is ready can lack a transport span/link. Absence is not filled by time proximity or a synthetic parent. A shared Query request keeps its first actual action/request owner; the source does not claim that every later consumer gets a new HTTP child.

The small RSC fetch adapter carries the matching action in the existing OTel context and records the returned Response headers. It neither consumes nor clones the response. The installed native fetch instrumentation already clones the transport response; its public post-fetch callback runs after that stream completes. Only that callback records RSC body completion. The regression holds a real ReadableStream open to distinguish these boundaries and verifies that the caller's Response remains usable.

`request.start` may carry the action root's IDs before a native transport exists. Headers/body carry the native child IDs, with the same request_id and action_id. Do not equate all phase span IDs with the action root or re-parent a completed prefetch request to a later click.

## Clock and provenance

Business durations use `performance.now()`. Business event epochs and explicit OTel action start/end times use `performance.timeOrigin + performance.now()`, converted to an HrTime tuple. There is no Date.now offset captured once at SDK startup. Delayed SDK binding preserves the original document/intent clock; retirement and persisted-page restoration keep their existing generation boundaries.

The locked native OTel fetch instrumentation owns HTTP span timestamps and uses Date.now for its end epoch. This change does not rewrite native spans or promise that a wall-clock jump is corrected inside that dependency. Use the measured business request phase durations for this case and report the native timing limitation. Worker spans use Cloudflare's clock; local CPU timing and hosted wall time must not be treated as interchangeable.

The normal Next build resolves a full 40-character SHA from WORKERS_CI_COMMIT_SHA, CF_PAGES_COMMIT_SHA, GITHUB_SHA, then NEXT_PUBLIC_FARO_RELEASE. It injects the resolved release and the explicit NEXT_PUBLIC_FARO_ENVIRONMENT (`production`, `qa` or `development`). No local Git HEAD fallback labels an uncommitted build as a frozen source. Missing or invalid values remain missing and have explicit status attributes. The frontend package version stays separate from release SHA.

Backend attributes include the actual CF_VERSION_METADATA.id. The custom Worker takes release/environment from Next's generated `.next/required-server-files.json` resolved `config.env`, before invoking OpenNext. This reuses the same build values as the frontend; it does not depend on OpenNext's later runtime process.env initialization or a second generator. The existing test aliases supply one JSON fixture for the generated build artifact. An actual build must still qualify the generated file and Worker bundle; a fixture is not deployed provenance. An incoming valid traceparent is recorded as `upstream_trace_id`/`upstream_span_id` and `trace_context=received`; these attributes prove receipt only. They do not prove that Cloudflare assigned a native parent. Missing values are explicit.

## Privacy, sampling and investigation

Existing consent/account/session generation checks still gate collection, transport and beforeSend. Revocation removes the RSC adapter and disables native HTTP instrumentation. Late old-generation requests cannot export accepted business events. The trace sanitizer preserves only valid link IDs and drops arbitrary link attributes, tracestate, status messages, events and raw URLs. Worker annotations use the same attribute whitelist. No cookies, tokens, session DTOs, personal content, SQL parameters or raw route identifiers are added.

The current Worker config samples traces at 0.05 and logs at 0.1. Missing backend spans can be sampling or propagation gaps. A collector HTTP 200/204 establishes delivery only, not a complete navigation trace. Confirm actual deployed source SHA, frontend release/environment, Worker version and observed IDs before correlating records. For latency, group comparable cold/hot cache and session cases, use critical-path overlap, and record sample counts. Do not sum parallel requests or infer p95/speed improvement from a single visit.

Madox owns independent runtime QA and Git/Hosted qualification for this work. Source tests and normal gates do not certify deployment, WebView journeys or production performance.

## Framework reuse and the remaining adapters

| Required behavior | Existing capability | Small remaining gap |
| --- | --- | --- |
| Avoid duplicate session DB lookup | BetterAuth signed cache + Next request header override | Forward refreshed cookies in the same request, including deletion the merge helper does not implement. |
| Overlap metadata with routing | TanStack Query `query(options).catch(noop)`, original key/queryFn/publisher | Check existing account/identity/access eligibility at navigation intent. |
| Associate pre-click work | Existing Faro/OTel context and Links | Match the current explicit target and carry the real original SpanContext. |
| Observe RSC transfer | Native fetch hooks | Carry business request ownership into the hook and expose actual headers/body boundaries. |
| Observe backend phases | Native Worker tracing and D1 instrumentation | Name existing auth stages and add whitelisted provenance/receipt attributes. |
| Stable business timing | Performance clock + OTel HrTime | One shared conversion for deferred and live action times. |

No new auth/session cache, promise/request coordinator, Query cache, canonical publisher, navigation proof, exporter or acceptance harness is introduced. Existing auth reuse, Query keys/lifetimes, entry/read owners and deployment sampling are retained because they already implement the required authority boundaries.

## References

The implementation is qualified against the repository lockfile and installed Next, BetterAuth, Faro, OTel, TanStack and Worker type sources. Relevant public contracts:

- [Next prefetching](https://nextjs.org/docs/app/guides/prefetching) and [request header overrides](https://nextjs.org/docs/app/api-reference/functions/next-response).
- [BetterAuth performance and signed cookie cache](https://better-auth.com/docs/guides/optimizing-for-performance).
- [TanStack Query prefetching](https://tanstack.com/query/latest/docs/framework/react/guides/prefetching).
- [Cloudflare custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/) and [known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).
- [Workers Builds environment variables](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
