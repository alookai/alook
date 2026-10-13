# OpenCode startup after model selection

## Features / show case
A bot configured with opencode/space-bunny-free must start the persistent native OpenCode service and reply through the injected Alook CLI. Do not substitute a different model or per-turn runtime. The reported machine uses daemon 0.1.49 and OpenCode v2.0.28 on macOS arm64.

## Designs overview
First reproduce the current daemon launch against the exact official 2.0.28 artifact, using isolated native state. Trace launch arguments, process exit and required HTTP/SSE capabilities before editing. Make the smallest compatibility repair established by reproduction. Keep the existing native process/session authority. A diagnosis-only change cannot close the reported failure.

## New deps
None planned. Native release packages used for private QA are not product dependencies.

## TODOS
- [x] Read both screenshots and verify selected model, daemon/native version and saved audit through scoped read-only D1 queries.
- [x] Verify and reproduce official 2.0.28 native startup; compare the working 1.18.35 control.
- [x] Determine the repair: separate CLI-major compatibility profiles and lanes inside the same OpenCode adapter. Preserve v1 native durable protocol. V2 uses its persisted paginated messages/inbox and new idle records, with common authenticated process/start/stop primitives.
- [x] Modify `src/daemon/agent-driver/src/adapters/opencode/index.ts`, `index.test.ts`, `src/daemon/agent-driver/src/sdk.test.ts`, `recent-context.ts`, `recent-context.test.ts`, and `service-lane.ts`; add `compatibility.ts`, `compatibility.test.ts`, `v2-service-lane.ts`, and `v2-service-lane.test.ts`. Protect existing v1 serve/models arguments; fix v2 readiness, payloads, model variants, pending-input recovery, native tool event/message recovery and terminal correlation. Preserve global recent-project discovery with CLI v2 native `api GET /api/session` rather than its project-scoped `session list`. Update `src/daemon/README.md`, `agent-driver/README.md`, and `agent-driver/RELEASE_NOTES.md` for both major lanes. Do not add a generic event ledger or new dependency.
- [x] Implement and run scoped tests, lint, typecheck, boundary checks and build.
- [x] Commit only after actual affected QA; push one PR and hand exact SHA to Claudette for independent acceptance.
- [ ] Track CI/coverage and preserve failed evidence until delivery. No production release without Gus execution-time confirmation.

### Test cases
- [x] Current reported command fails under 2.0.28 with recorded original native result.
- [x] Corrected native service starts with authenticated loopback and required API, and selected model reaches the native session.
- [x] Existing 1.18.35 native path, persistent reuse, startup cancellation and cleanup remain valid.
- [x] Unsupported/configuration failures retain a meaningful error without leaking credentials.

## QA tests
- [x] Actual bot journey: isolated local test owner creates/binds OpenCode bot with opencode/space-bunny-free; human message reaches daemon wake; native session shows exact selected model; injected CLI pulls/acks and sends the bot-authored reply. Correlate local D1 message, WS wake, daemon timeline and native session history. Preserve session for follow-up.
- [x] Two turns use one persistent native session and bot sends two stored replies; no seed helper acts as the bot.
- [x] Stop only owned native QA processes; no native OpenCode service remains. Preserve isolated synthetic session state and leave owner state/credentials untouched. Local web/queue/ws QA services stay available for independent acceptance.
- [ ] Claudette independently verifies the final committed artifact, exact model and visible bot reply.

## Local QA evidence (2026-10-13)
- Official CLI 2.0.28 rejects the prior `serve --pure` with exit 1. Original evidence is retained separately.
- CLI v2 real bot: one physical open, two native succeeded idle records, two injected CLI pulls and sends, two FSM root ends; exact `opencode/space-bunny-free`. An isolated Chrome context renders both bot-authored replies in the channel.
- CLI v1 1.18.35 real bot: one physical open, two FSM root ends, same selected model, two native durable prompt admissions and two stored bot-authored replies.
- CLI v2 native shell plus forced SSE disconnect: one reconnect, accepted busy input, native tool finishes, final response contains both requested markers, only current root settles. Native interrupt produces `interrupted` idle; `#high` persists as the actual model variant and generates a reply.
- CLI v2 global recent-project query finds the isolated bot project while `session list` from the repository returns zero; keeps read-only global discovery.
- 97 scoped tests pass; agent-driver typecheck/lint/knip/build and import-boundary checks pass. Daemon packed agent-driver isolation test passes.
- No production mutation/release. Exact committed artifact and independent acceptance remain required.

## CI follow-up
Initial CI found zero-bound discovery unnecessarily probing a missing CLI and an old SDK test treating Node as a supported OpenCode major. Zero-project discovery now returns the existing empty result without a version probe; SDK coverage verifies unsupported Node and a supported CLI shim separately.

## Coverage follow-up
Added focused tests for empty discovery with an unavailable CLI, actual override discovery dispatch, interrupt receipt versus native interrupted idle, failed native idle followed by session reuse, and transient recovery 503 without losing accepted input ownership. 141 focused tests and typecheck/lint pass. No production-code change in this follow-up.

## Recovery boundary completion
Complete patch coverage requires malformed native responses and close/admission races. Remove only redundant checks: parent start already verifies physical identity/session before invoking streams; admit owns its own failure cleanup, so beginRoot does not clear a second time. Pass the captured root into admit rather than rereading an impossible missing root. Retain every asynchronous identity/generation fence and durable recovery check. Repeat native QA for this small production simplification.

Final local candidate: 171 focused tests pass with no uncovered statements in the changed OpenCode modules; typecheck/lint/build/boundary/knip pass. After the small simplification, repeat native v1/v2 real-bot journeys, v2 disconnect/busy and interrupt all pass. Final independent QA and CI/Codecov remain merge gates.
