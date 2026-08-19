# Agent-driver final evidence

Production code commit: `f7d36456b7d9f4de67bdd32f2bc20a37099d649b`

The live runs below exercised the exact production tree committed above. The
follow-up evidence commit changes only this artifact and the audit ledger.
Credentials, prompts, and raw model output were not retained.

## Automated gates

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | PASS — 11/11 workspace tasks |
| `pnpm lint` | PASS — 5/5 workspace tasks |
| `pnpm test` | PASS — 11/11 workspace tasks; CI scripts 9 files / 57 tests |
| `pnpm knip` | PASS — 8/8 workspace tasks; pre-existing hints only |
| `pnpm typegrep:ws` | PASS |
| Agent-driver tests | PASS — 29 files / 262 tests |
| Daemon tests | PASS — 54 files / 1,097 tests |
| Workflow contracts | PASS — 13 tests |
| `node scripts/verify-agent-driver-ledger.mjs` | PASS — 8,232 collected cases, 568 mappings, zero missing targets |
| `node scripts/agent-driver-loc.mjs` | 10,690 lines vs 10,849 baseline (-159) |
| Clean daemon build | PASS — prior driver `dist` moved aside; prebuild rebuilt the package from source |
| Pack/install proofs | PASS — driver fixture 1 test; daemon packed boundary/version 2 tests |

The implementation commit hook repeated typecheck, lint, the full root test
suite, typegrep, and knip successfully before accepting the commit.

## Installed-backend lifecycle QA

The harness imported the clean-built package output and exercised real locally
installed backends. It recorded public receipts/events only.

| Backend | Installed version | Sanitized result |
| --- | --- | --- |
| Codex | 0.146.0 | Start accepted; exact-turn interrupt accepted; logical turn ended `interrupted`; the SIGINT process exit was truthfully reported `crashed`; exact returned-session-id resume and the resumed turn succeeded. Session SHA-256 prefix `76a64f39e760`; resumed text SHA-256 prefix `43f4341cdb03`. |
| Pi | 0.80.3 | Start accepted; tool start/finish observed; exact-turn interrupt accepted and ended `interrupted`; stop/close ended `stopped`; exact returned-session-id resume and the resumed turn succeeded. Session SHA-256 prefix `a218367ddea4`. |

## Independent `/c` QA

Independent agent: `alook-c-qa`

Run reference: `alook-c-qa-b69f1263.RYgtk6`

The run used a fresh browser group and isolated local services. The production
worktree under test was the tree later frozen as `f7d36456`; QA made no repository
changes. Services and the QA tab were stopped afterward, and ports 3000 and 8789
were clear.

| Journey | Result | Sanitized evidence |
| --- | --- | --- |
| Supported runtime creation | PASS | Picker offered exactly Claude, Codex, Cursor, OpenCode, and Pi. `POST /api/community/bots` returned 201 at `2026-08-19T12:17:38.511Z`; D1 stored `runtime=codex`; the machine received matching `bot:added`. |
| No-loss cancellation | PASS | Stored Gemini rendered unavailable. The complete D1 row was byte-identical before/after cancel: SHA-256 `7549a106661546993f8d36e82fc57ba5ee74e3dcf3259d962a6015aadd2a71e2`; machine-control update count remained zero. |
| Removed-runtime recovery | PASS | D1 stayed unchanged before save. `PATCH /api/community/bots/UovRxDAsE3q33jBeOWgq8` returned 200 at `2026-08-19T12:18:59.068Z`; D1 changed to `runtime=codex`, SHA-256 `63d6b962bc2f71446c6084043fcb33da84411660c783e3fca93a564067913d91`; one `agent:reset` carried `config.runtime=codex`. |

The sanitized run bundle contained `summary.json`, D1 before/after snapshots,
hashes, control-frame extracts, and `machine-frames.jsonl`. The local temporary
bundle was `/tmp/alook-c-qa-b69f1263.RYgtk6` at verification time.
