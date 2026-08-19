# Agent-driver final evidence

Production code commit: `4908cc25ca34eb18c71e5ef7ba4ee8cc248d33c9`

Production tree: `700a1f4ccc1a1f73243ef00c00f1079df981573b`

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
| Agent-driver tests | PASS — 30 files / 332 tests |
| Daemon tests | PASS — 55 files / 1,117 tests |
| Workflow contracts | PASS — 13 tests |
| `node scripts/verify-agent-driver-ledger.mjs` | PASS — 8,322 collected cases, 568 mappings, zero missing targets; seven semantic-audit claims valid |
| Changed-line coverage | PASS — 1,336 / 1,336 executable changed lines (100.0000%); zero missing |
| `node scripts/agent-driver-loc.mjs` | 10,797 lines vs 10,849 baseline (-52) |
| Clean daemon build | PASS — prior driver `dist` moved aside; prebuild rebuilt the package from source |
| Pack/install proofs | PASS — driver fixture 1 test; daemon packed boundary/version 2 tests |

The implementation commit hook repeated typecheck, lint, the full root test
suite, typegrep, and knip successfully before accepting the commit.

## Installed-backend lifecycle QA

The harness imported the clean-built package output and exercised real locally
installed backends. It recorded public receipts/events only.

| Backend | Installed version | Sanitized result |
| --- | --- | --- |
| Claude Code | 2.1.220 | Two consecutive root turns on one logical session were accepted and completed `success` through separate physical process generations; requested stop closed `stopped`. Exact returned-session-id resume then completed `success` and closed `stopped`. Session SHA-256 prefix `771f35cbe240`; combined two-turn text SHA-256 prefix `1d8722b4983f`. |
| Codex | 0.146.0 | Start/tool accepted; exact-turn interrupt accepted; logical turn ended `interrupted`; the physical process exit was truthfully reported `crashed`; exact returned-session-id resume succeeded, the resumed turn completed `success`, and requested stop closed `stopped`. Session SHA-256 prefix `c19a46ffec65`; resumed text SHA-256 prefix `d3ebf931065a`. |
| Pi | 0.80.3 | Start accepted; tool start/finish observed; exact-turn interrupt accepted and ended `interrupted`; stop/close ended `stopped`; exact returned-session-id resume succeeded, the resumed turn completed `success`, and requested stop closed `stopped`. Session SHA-256 prefix `7737c336a037`. |

## Independent `/c` QA

Independent QA role: `alook-c-qa` (executed directly because the owner prohibited subagents)

Run reference: `alook-c-qa-4908cc25.EQZRXx`

The run used a fresh browser tab and isolated local services on the exact
production head/tree above. The tracked worktree was clean before the run.
The browser-observed inventory contained 70 same-origin Next JS/CSS/font assets
(26,545,099 bytes) with canonical manifest root SHA-256
`af9a73a1000eb98fff242e6d491dd65e5416c550d21e27ae3aabbb516e21a7f7`.
QA made no repository changes.

| Journey | Result | Sanitized evidence |
| --- | --- | --- |
| Supported runtime creation | PASS | Picker offered exactly Claude, Codex, Cursor, OpenCode, and Pi. `POST /api/community/bots` returned 201; the stored row used `runtime=codex`; the same bot id arrived in exactly one `bot:added` frame at `2026-08-19T17:45:45.024Z`. |
| No-loss cancellation | PASS | Stored Gemini rendered unavailable. The complete normalized row was byte-identical before/after cancel: SHA-256 `1aaf185b9dff02e4580447d614984189777d0dbac3989ed221a0697044ba3a7d`; machine-control update count remained zero. |
| Removed-runtime recovery | PASS | The row stayed unchanged before save, `PATCH /api/community/bots/qa-removed-27bd` returned 200, then the row changed to `runtime=codex`, SHA-256 `b56ed1d93eb8d8f6dcc4396b9ae56329a23f2a63cebeea983c75b2b8447c1d78`; exactly one `agent:reset` carried `config.runtime=codex` at `2026-08-19T17:48:36.240Z`. |

The committed sanitized bundle `plans/agent-driver-final-qa-4908cc25.json`
records the exact commit/tree, clean-worktree proof, installed backend outcomes,
normalized row hashes, runtime picker set, control-frame counts, the canonical
root over all 70 served assets, a clean-built 160-file driver artifact root,
and an eight-file sanitized raw-evidence manifest.
The evidence manifest root is
`10e1853c344b389141e35fe44174f9a5aa006878b45e77a166020783ad82a8d8`.
Credentials, session tokens, prompts, raw model output, and browser session data
are omitted.
