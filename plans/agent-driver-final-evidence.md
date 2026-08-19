# Agent-driver final evidence

Production code commit: `0c839b6868b08672bc37cc9d04708e805a506b57`

Production tree: `7840ac7c1a5dc91727bf578f0b370b6f5dfb9079`

The live runs below exercised the exact production tree committed above. The
follow-up evidence commit changes only evidence artifacts and the audit ledger.
Credentials, prompts, and raw model output were not retained.

## Automated gates

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | PASS — 11/11 workspace tasks |
| `pnpm lint` | PASS — 5/5 workspace tasks |
| `pnpm test` | PASS — 11/11 workspace tasks; CI scripts 9 files / 57 tests |
| `pnpm knip` | PASS — 8/8 workspace tasks; pre-existing hints only |
| `pnpm typegrep:ws` | PASS |
| Agent-driver tests | PASS — 30 files / 345 tests |
| Daemon tests | PASS — 55 files / 1,119 tests |
| Workflow contracts | PASS — 13 tests |
| `node scripts/verify-agent-driver-ledger.mjs` | PASS — 8,337 collected cases, 568 mappings, zero missing targets; seven semantic-audit claims valid |
| Changed-line coverage | PASS — 1,341 / 1,341 executable changed lines (100.0000%); zero missing |
| `node scripts/agent-driver-loc.mjs` | 10,812 lines vs 10,849 baseline (-37) |
| Clean daemon build | PASS — prior driver `dist` moved aside; prebuild rebuilt the package from source |
| Pack/install proofs | PASS — driver fixture 1 test; daemon packed boundary/version 2 tests |

The implementation commit hook repeated typecheck, lint, the full root test
suite, typegrep, and knip successfully before accepting the commit.

The final lifecycle regression uses the real public SDK, `ClaudeDriver`, and
`ProcessLane`. In both same-chunk and split-chunk delivery, an old physical
lane emits terminal then a tail `tool_use`; after expected exit, turn B starts,
its own `tool_use`/`tool_result` boundary flushes queued command C exactly once,
and no tail tool count, compaction, review, error, or progress state crosses
into B. Persistent-process and SDK tombstone reopen/re-close coverage remains
unchanged and green.

## Installed-backend lifecycle QA

The harness imported the clean-built package output and exercised real locally
installed backends. It recorded public receipts/events only.

| Backend | Installed version | Sanitized result |
| --- | --- | --- |
| Claude Code | 2.1.220 | Two consecutive root turns on one logical session were accepted and completed `success` through separate physical process generations; requested stop closed `stopped`. Exact returned-session-id resume then completed `success` and closed `stopped`. Session SHA-256 prefix `faaacb5d6b82`; combined two-turn text SHA-256 prefix `1d8722b4983f`. |
| Codex | 0.146.0 | Start/tool accepted; exact-turn interrupt accepted; logical turn ended `interrupted`; the physical process exit was truthfully reported `crashed`; exact returned-session-id resume succeeded, the resumed turn completed `success`, and requested stop closed `stopped`. Session SHA-256 prefix `67869025ab21`; resumed text SHA-256 prefix `d3ebf931065a`. |
| Pi | 0.80.3 | Start accepted; tool start/finish observed; exact-turn interrupt accepted and ended `interrupted`; stop/close ended `stopped`; exact returned-session-id resume succeeded, the resumed turn completed `success`, and requested stop closed `stopped`. Session SHA-256 prefix `ad50607691f8`. |

## Independent `/c` QA

Independent QA role: `alook-c-qa` (executed directly because the owner prohibited subagents)

Run reference: `alook-c-qa-0c839b68.hsFrLU`

The run used a fresh browser tab and isolated local services on the exact
production head/tree above. The tracked worktree was clean before the run.
The browser-observed inventory contained 73 same-origin Next JS/CSS/font assets
(27,221,008 bytes) with canonical manifest root SHA-256
`0e9396c5cfc4bbf25ac00e0d6dd15a08bf892ffd21b430c3366698e2da9668eb`.
QA made no repository changes.

| Journey | Result | Sanitized evidence |
| --- | --- | --- |
| Supported runtime creation | PASS | Picker offered exactly Claude, Codex, Cursor, OpenCode, and Pi. `POST /api/community/bots` returned 201; the stored row used `runtime=codex`; the same bot id arrived in exactly one `bot:added` frame at `2026-08-19T19:19:51.547Z`. |
| No-loss cancellation | PASS | Stored Gemini rendered unavailable. The complete normalized row was byte-identical before/after cancel: SHA-256 `969cf70ccf02b9c00ecce5e9d38963d805b0a4931ccacad14a0d5b3c9b48bbcf`; machine-control update count remained unchanged. |
| Removed-runtime recovery | PASS | The row stayed unchanged before save, `PATCH /api/community/bots/qa-removed-27bd` returned 200, then the row changed to `runtime=codex`, SHA-256 `3abe7e5460e44b04ccd694209d009e34293cf75a36d5415816588da52ad3a30e`; exactly one new `agent:reset` carried `config.runtime=codex` at `2026-08-19T19:19:30.833Z`. |

The committed sanitized bundle `plans/agent-driver-final-qa-0c839b68.json`
records the exact commit/tree, clean-worktree proof, installed backend outcomes,
normalized row hashes, runtime picker set, control-frame counts, the canonical
root over all 73 served assets, a clean-built 160-file driver artifact root,
and an eight-file sanitized raw-evidence manifest.
The evidence manifest root is
`8a876907fe661eb83b23ab007e58fbe4be7b4ae2ed2515df2fff7fab752dfa49`.
Credentials, session tokens, prompts, raw model output, and browser session data
are omitted.
