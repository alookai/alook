# Agent-driver final evidence

Production code commit: `cc8f5fd555c797f9baec268717d7fc3d18c1a784`

Production tree: `5cef16e8d7dceca8183b7b9128d58a2b67a4baf8`

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
| Agent-driver tests | PASS — 30 files / 335 tests |
| Daemon tests | PASS — 55 files / 1,117 tests |
| Workflow contracts | PASS — 13 tests |
| `node scripts/verify-agent-driver-ledger.mjs` | PASS — 8,325 collected cases, 568 mappings, zero missing targets; seven semantic-audit claims valid |
| Changed-line coverage | PASS — 1,341 / 1,341 executable changed lines (100.0000%); zero missing |
| `node scripts/agent-driver-loc.mjs` | 10,814 lines vs 10,849 baseline (-35) |
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
| Claude Code | 2.1.220 | Two consecutive root turns on one logical session were accepted and completed `success` through separate physical process generations; requested stop closed `stopped`. Exact returned-session-id resume then completed `success` and closed `stopped`. Session SHA-256 prefix `bd01699771f0`; combined two-turn text SHA-256 prefix `1d8722b4983f`. |
| Codex | 0.146.0 | Start/tool accepted; exact-turn interrupt accepted; logical turn ended `interrupted`; the physical process exit was truthfully reported `crashed`; exact returned-session-id resume succeeded, the resumed turn completed `success`, and requested stop closed `stopped`. Session SHA-256 prefix `09cecdbb7332`; resumed text SHA-256 prefix `d3ebf931065a`. |
| Pi | 0.80.3 | Start accepted; tool start/finish observed; exact-turn interrupt accepted and ended `interrupted`; stop/close ended `stopped`; exact returned-session-id resume succeeded, the resumed turn completed `success`, and requested stop closed `stopped`. Session SHA-256 prefix `5d928232bf0e`. |

## Independent `/c` QA

Independent QA role: `alook-c-qa` (executed directly because the owner prohibited subagents)

Run reference: `alook-c-qa-cc8f5fd5.Q3DfMA`

The run used a fresh browser tab and isolated local services on the exact
production head/tree above. The tracked worktree was clean before the run.
The browser-observed inventory contained 73 same-origin Next JS/CSS/font assets
(27,209,192 bytes) with canonical manifest root SHA-256
`1f45c0c98899dd2edcf374f93b0da1b31464c29fb9c2c59dcdf828c6bddcabd9`.
QA made no repository changes.

| Journey | Result | Sanitized evidence |
| --- | --- | --- |
| Supported runtime creation | PASS | Picker offered exactly Claude, Codex, Cursor, OpenCode, and Pi. `POST /api/community/bots` returned 201; the stored row used `runtime=codex`; the same bot id arrived in exactly one `bot:added` frame at `2026-08-19T18:27:55.340Z`. |
| No-loss cancellation | PASS | Stored Gemini rendered unavailable. The complete normalized row was byte-identical before/after cancel: SHA-256 `f2bc69c4b2310b1c27470b2c00294839e57470c15586a1a0e32d000c1db7ca1b`; machine-control update count remained zero. |
| Removed-runtime recovery | PASS | The row stayed unchanged before save, `PATCH /api/community/bots/qa-removed-27bd` returned 200, then the row changed to `runtime=codex`, SHA-256 `ac13da235aa2c831ba44e0a426f7e407572f36f89270386a85d872e20bb3eb44`; exactly one `agent:reset` carried `config.runtime=codex` at `2026-08-19T18:32:08.035Z`. |

The committed sanitized bundle `plans/agent-driver-final-qa-cc8f5fd5.json`
records the exact commit/tree, clean-worktree proof, installed backend outcomes,
normalized row hashes, runtime picker set, control-frame counts, the canonical
root over all 73 served assets, a clean-built 160-file driver artifact root,
and an eight-file sanitized raw-evidence manifest.
The evidence manifest root is
`ffb0ba4d221347d633ab21d8372bc6d247c84c8e2dad78d5e5cc98444e392020`.
Credentials, session tokens, prompts, raw model output, and browser session data
are omitted.
