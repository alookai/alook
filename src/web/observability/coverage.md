# Frontend observability

Main and the independently built Blog use Faro for consent-gated frontend diagnostics. This document describes configuration and event meanings; release-specific QA results belong in the PR and its evidence attachments.

## Build configuration

Set the public Collector before **both Main and Blog builds**. Environment and release are optional diagnostic labels:

| Variable | Accepted value |
| --- | --- |
| `NEXT_PUBLIC_FARO_COLLECTOR_URL` | Environment-specific HTTPS Collector URL without credentials, query or fragment |
| `NEXT_PUBLIC_FARO_ENVIRONMENT` | `production` or `qa` |
| `NEXT_PUBLIC_FARO_RELEASE` | Actual build's full lowercase 40-character Git SHA |

Set the actual values in each Worker's Settings → Builds → Build variables and secrets. Keep them out of committed source; the existing deployment commands do not supply them. The client reads `NEXT_PUBLIC_*` directly, and Next substitutes them during each build. These public values therefore appear in the browser bundle; Grafana management credentials are never client configuration. [Cloudflare build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [Next environment variables](https://nextjs.org/docs/app/guides/environment-variables).

Only a missing or invalid Collector URL disables collection. Absent or invalid optional labels are omitted from native metadata and events. Changing Worker runtime variables after a build does not update the browser bundle. Use the Collector and allowed origins for the chosen environment. If a release label is supplied, derive it from the current build instead of retaining a previous candidate's SHA.

Collection also requires the existing analytics-consent grant. Account changes, consent withdrawal/regrant and native session expiry retire the previous diagnostic ownership. Late callbacks and spans must retain their original owner and cannot publish into a replacement session.

## Event meanings

The executable [route/action registry](../src/lib/observability/coverage.ts) defines fixed names and source entry points. The [event schema](../src/lib/observability/schema.ts) defines accepted fields and enums; dynamic message or DOM text is not an action name.

| Event | Meaning |
| --- | --- |
| `action.start` / `action.finish` | Start and qualified terminal outcome of an explicit action, associated by `action_id` |
| `navigation.intent` / `navigation.commit` | Intended navigation and the committed route; content readiness is measured separately |
| `region.read` / `region.ready_commit` | Evidence for the view read and its qualified React content commit, including legal empty content |
| `region.frame_estimate` | A subsequent animation-frame estimate; not proof that pixels were painted |
| `request.*` | Request start, headers, parsed body and qualified finish; native tracing supplies HTTP spans |
| `ws.event_applied` | Completion of the existing projection transaction; rendered changed-row evidence is a separate boundary |
| `business.result` / `message.milestone` | Business outcome or message progress at the existing operation owner |

Data `source` is one of `restored_idb`, `network`, `ws`, `local_mutation`, `mixed` or `unknown`. Keep source, version, freshness and display eligibility separate. A mounted view or successful request does not by itself prove that the intended content is readable.

## Privacy and capability boundaries

- Export only sanitized fixed enums, bounded numbers and qualified diagnostic/account IDs. Do not export message content, emails, auth tickets, query values, exception messages or arbitrary log/span content.
- Propagate traces only to the current origin, excluding the Collector. Frontend spans do not establish Cloudflare/D1/WS correlation without matching backend evidence.
- Keep unavailable SSR/RSC cache origin `unknown`; `transferSize=0` is not cache-hit proof.
- Observe in-app handoff/results for external OAuth, payment pages and native OS actions. Do not instrument their internals or ticket-bearing Auth HTML.
- Queues, action lifetimes and delivery retries are bounded. Delivery failures count failed deliveries, not inferred lost events. The SDK's paused private buffer is filtered at export; do not claim it was physically cleared.
- Unit/DOM tests establish their executed contracts. Builds establish their compiled configuration. Real journeys and received Collector events need their own matching release, session and action evidence.
