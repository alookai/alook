# Web Architecture

> The target code architecture for Alook Web.

The root [`DESIGN.md`](../../DESIGN.md) owns visual, interaction, responsive, accessibility, and content standards. This document owns code organization, state, data flow, request timing, reliability, and extension boundaries.

Implementation order and migration steps live in `plans/web-architecture-refactor.md`, not here.

## Core rules

1. Web is a modular monolith organized by product capability.
2. The URL owns navigation state.
3. TanStack Query is the only browser cache for remote data.
4. Zustand stores only transient client state shared across components.
5. Complex screens use Controller–View; Views do not touch APIs, router state, QueryClient, or product permissions.
6. Reads use Queries, writes use Commands, and realtime uses central Event Projectors.
7. Decode each incoming WS frame once per authenticated shell; every projector is idempotent.
8. Restore usable cache before mounting matching requests; mount data at App, Layout, Page, or Interaction scope.
9. Route adapters authenticate, parse, invoke one typed handler, and map its response.
10. Request Workers and application services are stateless. Durable Objects are the explicit stateful coordination boundary; important facts are durable.

Architecture changes preserve existing UI, URLs, copy, interaction, responsive behavior, and accessibility unless a separate product change says otherwise.

## System shape

```text
Read
  Route -> Screen Controller -> Client Query -> HTTP Route
        -> Server Query Handler -> Scoped Query -> D1 / R2 / KV

Write
  User Intent -> Controller -> Client Command -> HTTP Route
              -> Server Command -> Atomic Durable Write -> Response
                                      |
                                      +-> Outbox Intent -> Relay -> Queue -> Consumer

Realtime
  WS Frame -> Versioned Decoder -> Event Registry -> Event Projector
                                             |-> Query cache
                                             |-> Invalidation
                                             +-> Transient store
```

Dependencies point toward stable contracts. Infrastructure implements capabilities; it does not define product policy.

## Ownership and placement

### Final directory structure

```text
src/web/
  src/
    app/                         Next routes and route handlers
    modules/                     Product modules
      community/                 Servers, channels, forums, DMs, people, bots, machines
      workspace/                 Workspace shell, settings, runtimes, attention surfaces
      agent/                     Agent profile, chat, email, files, meetings, skills, activity
      studio/                    Agent creation and onboarding
      calendar/                  Calendar views and events
      work/                      Issues, tasks, and traces
      auth/                      Sign-in and authenticated boundaries
      marketing/                 Home, blog, templates, SEO, and public content surfaces
    components/
      ui/                        Product-agnostic visual primitives
    platform/
      client/                    Query, persistence, navigation, realtime runtime
      server/                    Auth, Cloudflare bindings, transport, logging
    content/                     Static content
    test/                        Cross-module and app-level test utilities
  public/                        Public static assets
  migrations/                    D1 migrations owned by Web deployment
  custom-worker.ts               OpenNext extension and edge transport composition
  open-next.config.ts            OpenNext runtime and cache configuration
  wrangler.toml                  Cloudflare deployment configuration
  cloudflare-env.d.ts            Generated binding types
  next.config.ts
  package.json
```

Each module may expose three environment-specific public entries:

```text
modules/<module>/
  client/
    index.ts                     Browser-safe public API
  server/
    index.ts                     Server-only public API
  shared/
    index.ts                     Pure contracts and functions
```

Create only the directories a module needs. Client and Server do not need symmetric internals.

### Product ownership

| Surface or capability | Owner |
| --- | --- |
| `/c`, channel tree, messages, forum, DM, inbox, social graph | `modules/community` |
| Community bots, machines, notification policy, delivery | `modules/community` |
| `/w`, workspace shell, settings, runtimes, flags, unread | `modules/workspace` |
| Agent chat, email, files, meetings, skills, activity | `modules/agent` |
| Agent creation and onboarding | `modules/studio` |
| Calendar views and event mutations | `modules/calendar` |
| Issues, tasks, and traces | `modules/work` |
| Session, sign-in, and authenticated route boundaries | `modules/auth` |
| Home, blog, templates, public SEO and metadata | `modules/marketing` |
| Generic Button, Dialog, Popover, Avatar, focus and motion | `components/ui` |
| QueryClient, IDB, navigation, WS transport, analytics | `platform/client` |
| Auth adapter, D1, R2, KV, Queue, DO/ws-do, logs | `platform/server` |

If ownership is unclear, do not add a catch-all root `lib`, `hooks`, `stores`, or `contexts` home. Resolve the product owner first.

### Placement decision

```text
Next route entry?                    -> app/
User-recognizable capability?        -> modules/<owner>/client or server
Pure client/server contract?         -> modules/<owner>/shared
Used by two workspace packages?      -> @alook/shared
Product-agnostic visual primitive?   -> components/ui
Browser or Cloudflare capability?    -> platform/client or platform/server
```

### Dependency rules

| Source | May depend on | Must not depend on |
| --- | --- | --- |
| `app` page/layout | Public module entries, platform bootstrap | Module internals |
| `app/api` | Public server Query/Command, route middleware | Views, browser stores |
| Module client | Own shared code, public cross-module contracts, `platform/client`, `components/ui` | Module server, Cloudflare bindings |
| Module server | Own shared code, public server contracts, `platform/server`, `@alook/shared` | React Views, IDB, browser stores |
| Module shared | Pure types, schemas, functions | React, Next APIs, browser APIs, Cloudflare Env |
| `components/ui` | Tokens and product-agnostic utilities | Product modules, router, Queries |
| Platform | Framework and infrastructure libraries | Product policy |
| `@alook/shared` | Cross-package schemas, scoped queries, contracts | `src/web` |

Browser entries import `client-only`; server entries import `server-only`. A browser-safe contract never comes from a barrel that also exports server code.

Cross-module imports use public entries. A dependency cycle means ownership is misplaced; do not hide it behind a global Event Bus.

### Package root

- `custom-worker.ts` composes the generated OpenNext handler, WS upgrade interception, and delegated edge cache policy. Product route/cache classification lives behind `platform/server`, not inline in the entry.
- `open-next.config.ts` configures OpenNext runtime, incremental cache, queue, and tag cache only.
- `wrangler.toml` is the source of truth for bindings, assets, observability, and deployment configuration.
- Access Cloudflare services through bindings, not REST API calls from the Worker.
- Keep `compatibility_date` current intentionally and verify each update.
- Generate `cloudflare-env.d.ts` with `wrangler types`; never edit it by hand.
- `migrations/` belongs to the package that deploys and migrates D1.

## App and feature boundaries

### `app/`

`app/` adapts Next.js to product modules:

| File | Responsibility |
| --- | --- |
| `page.tsx` | Parse route input and render a public Screen |
| `layout.tsx` | Establish route scope and compose a public Shell |
| `route.ts` | Establish actor/public access, parse, invoke one handler, map response |

Metadata and public/authenticated route boundaries also live here.

Routes do not own permission policy, database workflows, fanout, Agent wake, or cache projection.

### Feature shape

A complex client Feature may use:

```text
feature/
  feature-screen.tsx
  feature-controller.ts
  feature-view.tsx
  feature-queries.ts
  feature-commands.ts
  feature-realtime.ts
  feature-model.ts
  feature-types.ts
  index.ts
```

Do not create files the Feature does not need.

A public entry exports only Screens, stable contracts, and integrations that another owner genuinely uses. It does not export private Controller state, cache patchers, Query implementations, internal Views, or server-operation steps.

### Server and Client Components

Use a hybrid App Router architecture.

| Server Components own | Client Components own |
| --- | --- |
| Route and auth boundaries | Interactive application Shell |
| Session resolution and redirects | Ongoing TanStack Query state |
| Stable initial identity | Query persistence and WS connection |
| Bootstrap that removes a real waterfall | Composers, virtual lists, DnD, dialogs, sheets |
| Static content and metadata | High-frequency realtime surfaces |

Do not mark an entire route tree `use client` for one interactive leaf. Do not server-render every high-frequency timeline Query for nominal SSR consistency.

## Controller–View

Use Controller–View only for complex screens.

```text
ChannelScreen -> useChannelController() -> ChannelView
```

| Controller | View |
| --- | --- |
| Accepts route input | Renders from props |
| Mounts Queries and Commands | Keeps visual local state |
| Derives permissions and ViewModel | Emits named user intents |
| Coordinates one Feature | Uses visual focus/breakpoint hooks |

A View does not build API URLs, read QueryClient, patch caches, register global handlers, decide permissions, or create a WebSocket.

Small components stay simple. Split by responsibility and lifecycle, not line count.

## State ownership

| State | Sole owner |
| --- | --- |
| Current route, server, channel, thread, DM, URL filters | URL / App Router |
| Remote entities and read models | TanStack Query |
| Authenticated identity | Auth boundary |
| WS connection lifecycle | Realtime Client/store |
| Presence, typing, short-lived realtime deltas | Realtime Store |
| Dialog, popover, hover, temporary selection | Nearest component or Controller |
| Composer drafts and layout preferences | User-scoped browser persistence |
| Persisted Query snapshots | TanStack Query persister |
| Permissions, memberships, read cursors, approvals | D1 |
| Agent runtime state | Durable local Agent storage |
| Reliable background work | Queue or persisted Outbox |

Never:

- copy URL parameters into a global store;
- copy complete Query entities into Zustand;
- synchronize two owners with opposing Effects;
- keep important state in module variables;
- reuse Query caches or browser-persistence namespaces across users.

Compute derived state on read unless the computation is expensive and invalidation is explicit.

## Request timing and cache

Mount each request at the lowest boundary that owns its full lifecycle.

| Scope | Typical data | Lifetime |
| --- | --- | --- |
| App | Identity, QueryClient, persister, one WS, global attention | Authenticated shell |
| Layout | Current server tree, membership, sidebar unread, DM directory | Route segment |
| Page | Scope metadata, timeline, read cursor, minimum composer data | Leaf route |
| Interaction | Search, pins, profile, audit, diagnostics, settings | Surface open |

Required data for the same boundary starts together. Optional data mounts when its surface opens.

```text
Enter route
  -> stable Shell
  -> restore allowed Query snapshots from IDB
  -> mount App / Layout / Page Queries
     -> cache hit: render and reconcile in background
     -> cache miss: local skeleton and request
  -> mount Interaction data and code on demand
```

IDB persists selected Query snapshots; it is not a second product database.

- Components never read remote entities directly from IDB.
- Matching Query fetches wait until restore completes.
- Server hydration and IDB snapshots reconcile by data timestamp or version.
- Persisters are namespaced by user/workspace and define buster, max age, GC, and capacity.
- Persist only successful, stable, bounded, valuable Queries.
- Never persist presence, typing, connection state, upload progress, errors, promises, or unbounded history.
- Account switch destroys the old QueryClient, persister, WS, and transient state.

| Available data | Transport | UI |
| --- | --- | --- |
| None | Loading online | Local skeleton |
| Cache | Refreshing online | Keep content visible |
| Cache | Offline | Cached content plus stale/offline state |
| None | Offline | Local Offline/Error State |

On-demand has five independent controls: Query lifetime, JavaScript split, DOM virtualization, subscription granularity, and local loading boundaries.

## Query and Command

### Client Query

TanStack Query owns remote browser state. One Query definition centralizes:

- key and normalized input;
- typed fetcher and runtime response validation;
- freshness, retry, GC, and persistence policy;
- reusable projections.

A Query has no side effects. It does not navigate, toast, write Zustand, mark read, or register realtime subscriptions. The same resource never gets unrelated keys in different files.

Bootstrap Queries may serve shell, server, route, inbox, or bot/machine boundaries. A bootstrap is a read facade, not a source of truth.

### Client Command

A Client Command represents one complete user intent. It owns:

- input normalization;
- one explicit API/workflow call;
- optimistic update and rollback;
- typed failures;
- centralized cache policy.

Examples: send message, create channel, change notification level, approve bot request, pair machine, reset session, mark an observed range read.

### Server handlers

| Handler | Owns |
| --- | --- |
| Server Query Handler | Typed actor/input, scoped authorization, read projection |
| Server Command | Typed actor/input, scoped authorization, atomic durable write, side-effect intent, response projection |

Use functions with explicit dependencies:

```ts
getChannelRoute(deps, actor, input)
sendMessage(deps, actor, input)
```

The auth boundary resolves the actor once. The handler remains authoritative for scoped authorization.

## Realtime

Each mounted authenticated application Shell owns at most one Realtime Client. It exposes connect/authenticate, subscribe/unsubscribe, supported outbound frames, and close.

Only that client reads raw frames. Components observe Queries or the Realtime Store; they never depend on a module-level mutable `send` binding or mount order.

### Event policies

| Policy | Requirement | Result |
| --- | --- | --- |
| Patch | Complete validated payload and provable aggregate order | Update existing cache immutably |
| Invalidate | Change is known but projection is incomplete or expensive | Mark matching Queries stale |
| Transient | Latest-wins presence, typing, connection, short-lived delta | Update bounded transient store |
| Reconcile | Gap, reconnect, version conflict, permission change | Rebuild active scopes from durable sources |

### Event contract by policy

| Policy | Identity and ordering |
| --- | --- |
| Patch | Contract version, producer, audience, resource scope, aggregate id, aggregate seq/version, operation/event identity |
| Invalidate | Contract version, producer, audience, affected scope; handler must be idempotent |
| Transient | Contract version, scope, latest-wins key, TTL/expiry or reconnect-reset rule |
| Reconcile | Authoritative snapshot source, active-scope selector, conflict/gap trigger |

Mutation responses and WS echoes share `clientNonce` or another operation identity when optimistic convergence needs it.

Adding required envelope fields is a new protocol version. Legacy frames are translated at the decoder boundary; internal projectors consume one canonical event.

### Event Impact Matrix

Every event declares all affected targets in one registry.

| Event | Target | Policy |
| --- | --- | --- |
| `message.created` | Existing channel timeline | Patch append |
| `message.created` | Channel/thread summary | Patch or Invalidate |
| `message.created` | Inbox/unread for every eligible recipient | Patch or Invalidate |
| `mention.created` | Attention/mention projection | Patch or Invalidate |
| `message.edited` | Message detail and cached timelines | Patch |
| `message.edited` | Forum/thread summary | Invalidate |
| `membership.changed` | Members, permissions, server tree | Invalidate |
| `typing.changed` | Typing overlay | Transient |

Project once per Query key. When one entity exists under several keys, its projector explicitly handles every target.

### Projection rules

- Ignore duplicate operation/event identity and older aggregate versions for ordered Patch events.
- Apply contiguous ordered patches only; reconcile on a gap or unknown order.
- Invalidate handlers are idempotent and do not require a synthetic global sequence.
- Transient events use latest-wins/TTL semantics and rebuild or clear on reconnect.
- A Patch is a no-op when its target cache does not exist.
- Inactive Queries may become stale without refetching.
- Reconnect restores only active scopes declared by the registry.
- Preserve references when semantics do not change.
- Event handlers do not navigate, toast, or open dialogs.

TanStack Query owns durable entities. A realtime overlay contains only bounded, unreconciled deltas with an explicit merge key, drain rule, and reconnect behavior.

## Server architecture

### Route adapter

```text
authenticate or establish public actor
  -> parse and validate
    -> invoke one Server Query Handler or Server Command
      -> map typed result to HTTP
```

The route owns no database details, permission branches, fanout, Agent wake, or response projection.

### Scoped access

Policies own channel access, message edit/delete, notification level, bot-owner approval, and machine ownership. UI permissions improve affordance only.

Scope before querying:

```ts
getAccessibleChannel(db, { actorId, serverId, channelId }) // correct
getChannel(channelId)                                     // wrong if ownership is checked later
```

Prefer Drizzle operators. Use raw SQL only when the ORM has no equivalent.

### Channel model

```text
server
  -> top-level channel
    -> child post / thread
      -> messages

DM channel
  -> messages
```

Channel kinds use a discriminated union. UI selects the Surface, Query selects the projection, and domain policy selects access, membership, and notifications.

Use exhaustive switches for clear branches. Introduce a registry only when real extension pressure exists.

### Explicit state machines

Use discriminated unions for multi-stage behavior such as realtime connection, upload/send, machine pairing, bot approval, Agent runtime activity, and page readiness.

```ts
type SendState =
  | { status: "idle" }
  | { status: "uploading"; progress: number }
  | { status: "sending"; clientNonce: string }
  | { status: "failed"; error: SendError; retryable: boolean }
```

Important workflow state is durable. Add a state-machine dependency only when guards, parallel states, or visualization justify it.

## Cloudflare state and delivery

### State boundaries

| Runtime | Allowed state |
| --- | --- |
| Request Worker/application service | No important in-memory state across requests |
| Durable Object | Stateful coordination, live sockets, bounded rebuildable cache |
| DO storage / D1 | Durable relational or coordination facts |
| R2 | Durable objects and files |
| Queue | Durable at-least-once work delivery |
| Durable local Agent storage | Agent runtime state owned by the local runtime |

Durable Object in-memory state may disappear on eviction or restart. Persist every fact required for recovery in DO storage, D1, R2, or durable local storage.

### Delivery levels

| Level | Use | Contract |
| --- | --- | --- |
| Reliable invariant | A committed fact must eventually cause an external effect | Atomic D1 fact + Outbox row, durable relay, at-least-once Queue, idempotent consumer |
| Best-effort hint | Loss is repaired by later read/reconcile | `ctx.waitUntil` or direct ws-do push; failure is observable but does not roll back the fact |

Reliable flow:

```text
Atomic D1 batch
  -> write domain fact
  -> write Outbox intent with stable id

Outbox relay
  -> claim with lease
  -> publish to Queue
  -> record publish outcome / retry expired lease

Queue consumer
  -> reread authoritative eligibility when required
  -> perform idempotent effect using intent id
  -> record terminal outcome or retry/dead-letter
```

D1, Queue, ws-do, and R2 do not share one transaction. R2 workflows define reserve/finalize or compensation when partial completion matters.

Cloudflare Queues are at-least-once; consumers must tolerate duplicates and cannot assume global ordering.

Use an Outbox only when losing the effect after a durable commit violates a user-visible invariant. Realtime cache hints can remain best-effort when read/reconnect reconciliation repairs them.

## Adapters and compatibility

Adapters isolate Codex, Claude Code, Cursor, OpenCode, Pi, browser realtime, ws-do transport, machine control, R2, and Queue protocols. They translate protocols; they do not decide authorization, audience, or notification policy.

Browser producer/consumer contracts deployed with Web use typed requests, runtime schemas, centralized clients, and versions for long-lived tabs and persisted caches.

CLI, daemon, Workers, desktop, mobile, and independently deployed Service Bindings use versioned `@alook/shared` schemas, additive evolution, minimum compatible versions, and bounded compatibility windows.

```text
legacy input  -> legacy adapter --┐
                                  ├-> canonical contract -> application code
current input -> current adapter -┘
```

Version checks live only in route adapters, protocol decoders, capability adapters, and compatibility tests. Views, Controllers, Queries, Projectors, Policies, and Server Commands consume canonical contracts only.

## Errors and performance

### UI states

| State | Meaning |
| --- | --- |
| Loading | No authoritative result exists yet |
| Refreshing | Keep trusted data while refreshing |
| Stale | Trusted old data exists; refresh failed |
| Empty | Successful read returned no rows |
| Forbidden | Actor may not access the resource |
| Not found | Resource is absent or intentionally hidden |
| Offline | Transport unavailable; cache may remain usable |
| Error | Failure with an explicit recovery action |

Adapters translate transport errors. Queries and Commands return typed application errors. Controllers choose retry, fallback, and user feedback. Error Boundaries handle unexpected render failures.

### Performance rules

- Fix ownership before memoization.
- Subscribe to the smallest stable Query projection or store slice.
- No-op setters and preserve references when semantics do not change.
- Virtualize long lists with stable keys, measurements, and scroll anchors.
- Presence ticks do not rerender unrelated message bodies.
- Bound memory cache and IDB by capacity, max age, and GC policy.
- Keep usable cached content visible during reconciliation.
- Maintain a first-screen request inventory; every waterfall needs a reason.
- Code-split heavy optional surfaces by route or interaction.
- Validate performance claims with browser instrumentation.

## Pattern policy

Patterns solve demonstrated problems; they are not a directory checklist. GoF names follow the [Refactoring.Guru catalog](https://refactoringguru.cn/design-patterns/catalog).

### Architecture and application patterns

| Pattern | Used for | Constraint |
| --- | --- | --- |
| Feature-oriented Modular Monolith | Overall organization | One deployment, capability boundaries |
| CQRS-lite | Read Queries and write Commands | No Event Sourcing requirement |
| Controller–View | Complex interactive Screens | Small components need no Controller |
| Policy Object | Authorization, notifications, approval | Scope before querying |
| Explicit State Machine | Connection, send, pairing, approval | Union/reducer by default; durable facts remain durable |
| Transactional Outbox | Durable fact plus required effect | Includes relay, retry, idempotency, terminal outcome |

CQRS Commands and union-based state machines are project architecture terms, not automatically GoF Command or GoF State.

### GoF patterns used conditionally

| Pattern | Use only when | Avoid when |
| --- | --- | --- |
| Adapter | An external protocol must map to a canonical contract | A local function already has the required contract |
| Facade | A module needs a small stable public entry over real complexity | It only forwards calls without reducing coupling |
| Observer | One event must notify several independent projections | Direct ownership or one callback is sufficient |
| Strategy | A real family of interchangeable algorithms shares one interface | Branches are clearer as functions or an exhaustive switch |
| Composite | Leaf and container nodes are operated through one component contract | Data merely happens to form a tree |
| Command | A request must be an object for queueing, history, scheduling, or undo | A typed application function is sufficient |
| State | Behavior must delegate to interchangeable state objects | A discriminated union and reducer are clearer |

### Not used by default

- Singleton services or module-level mutable application state.
- Service Locator or global Mediator/Event Bus.
- Generic Repository base classes.
- Abstract Factory without a real construction policy.
- Template Method when function composition is clearer.
- All-purpose Command or Transport with arbitrary payloads.
- Community Micro-frontends.
- Full Event Sourcing.
- Workflow frameworks when persisted state plus Queue is sufficient.

An exception must name the concrete problem, simpler rejected option, owner, lifecycle, failure/recovery behavior, and removal cost.

## Testing contract

Tests protect behavior and public contracts, not incidental implementation.

| Level | Must cover |
| --- | --- |
| Pure unit | Route/state builders, Policies, reducers, Projectors, Query keys, ViewModels |
| Component | View intents, Controller boundaries, loading/stale/empty/denied/retry, a11y |
| Contract | Public exports, HTTP/WS schemas, adapters, cache reconciliation, query scope |
| Integration | Route→handler→D1, cache lifecycle, optimistic rollback, WS projection, Outbox/Queue |
| Browser QA | User-visible result plus D1 row, WS frame, Queue outcome, or Worker log |

Ordered realtime tests cover duplicate identity, older version, gap, optimistic echo, reconnect, inactive cache, and Transient expiry/reset.

Use source-text assertions only for architecture rules that types, lint, or module boundaries cannot enforce.

Executable `/c`, Community shared-query/schema, or ws-do changes run `alook-c-qa`.

## Ship checklist

- [ ] One product module owns the change; imports use public environment-specific entries.
- [ ] URL, Query, transient, and durable state each have one owner.
- [ ] Views are independent of APIs, router state, QueryClient, WS, and product permissions.
- [ ] Requests mount at the lowest complete App/Layout/Page/Interaction lifecycle.
- [ ] IDB restore, account isolation, stale/offline behavior, and loading geometry are defined.
- [ ] Queries are side-effect free; each Command represents one complete intent.
- [ ] Actor and resource scope constrain reads before rows are returned.
- [ ] Every realtime event declares targets, policy, identity/ordering semantics, and reconnect behavior.
- [ ] Required delivery survives termination after commit; Queue consumers are idempotent.
- [ ] Important state survives Worker/DO restart or is explicitly rebuildable.
- [ ] Errors are typed and loading, refreshing, stale, empty, forbidden, offline, and error stay distinct.
- [ ] Focused tests, relevant browser QA, typecheck, lint, and coverage gates pass.

If any answer is unclear, the target architecture is incomplete.
