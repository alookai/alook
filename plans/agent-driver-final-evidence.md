# Agent-driver final evidence

Production code commit: `27bd08d08e8692c871a2073e49a2c563963e3f70`

Production tree: `f6bd126dea804b3aefb17f35fbba457594af0420`

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
| Agent-driver tests | PASS — 31 files / 330 tests |
| Daemon tests | PASS — 55 files / 1,117 tests |
| Workflow contracts | PASS — 13 tests |
| `node scripts/verify-agent-driver-ledger.mjs` | PASS — 8,320 collected cases, 568 mappings, zero missing targets; seven semantic-audit claims valid |
| Changed-line coverage | PASS — 1,335 / 1,335 executable changed lines (100.0000%); zero missing |
| `node scripts/agent-driver-loc.mjs` | 10,826 lines vs 10,849 baseline (-23) |
| Clean daemon build | PASS — prior driver `dist` moved aside; prebuild rebuilt the package from source |
| Pack/install proofs | PASS — driver fixture 1 test; daemon packed boundary/version 2 tests |

The implementation commit hook repeated typecheck, lint, the full root test
suite, typegrep, and knip successfully before accepting the commit.

## Installed-backend lifecycle QA

The harness imported the clean-built package output and exercised real locally
installed backends. It recorded public receipts/events only.

| Backend | Installed version | Sanitized result |
| --- | --- | --- |
| Codex | 0.146.0 | Start/tool accepted; exact-turn interrupt accepted; logical turn ended `interrupted`; the physical process exit was truthfully reported `crashed`; exact returned-session-id resume succeeded, the resumed turn completed `success`, and requested stop closed `stopped`. Session SHA-256 prefix `61d9aecb922a`; resumed text SHA-256 prefix `d3ebf931065a`. |
| Pi | 0.80.3 | Start accepted; tool start/finish observed; exact-turn interrupt accepted and ended `interrupted`; stop/close ended `stopped`; exact returned-session-id resume succeeded, the resumed turn completed `success`, and requested stop closed `stopped`. Session SHA-256 prefix `37d85123f525`. |

## Independent `/c` QA

Independent QA role: `alook-c-qa` (executed directly because the owner prohibited subagents)

Run reference: `alook-c-qa-27bd08d0.XOKKTI`

The run used a fresh browser tab and isolated local services on the exact
production head/tree above. The tracked worktree was clean before the run.
The browser-observed inventory contained 62 same-origin Next JS/CSS assets
(26,192,229 bytes) with canonical manifest root SHA-256
`f6e4383544e545876ad459ce3ded5ba525e0c89a1f087431905a3ca319b51c0e`.
QA made no repository changes.

| Journey | Result | Sanitized evidence |
| --- | --- | --- |
| Supported runtime creation | PASS | Picker offered exactly Claude, Codex, Cursor, OpenCode, and Pi. `POST /api/community/bots` returned 201; the stored row used `runtime=codex`; the same bot id arrived in exactly one `bot:added` frame at `2026-08-19T17:03:31.384Z`. |
| No-loss cancellation | PASS | Stored Gemini rendered unavailable. The complete normalized row was byte-identical before/after cancel: SHA-256 `d1be123794334ce95620ba1baefccb42770c7c1f2b85172adabb3acaf1c59f8b`; machine-control update count remained zero. |
| Removed-runtime recovery | PASS | The row stayed unchanged before save, `PATCH /api/community/bots/qa-removed-27bd` returned 200, then the row changed to `runtime=codex`, SHA-256 `04ac49f6c0c7c85b3a3f1967609b5653034799afd1cbb6b4fc5a1270927db6d5`; exactly one `agent:reset` carried `config.runtime=codex` at `2026-08-19T17:09:10.964Z`. |

The committed sanitized bundle `plans/agent-driver-final-qa-27bd08d0.json`
records the exact commit/tree, clean-worktree proof, installed backend outcomes,
normalized row hashes, runtime picker set, control-frame counts, the canonical
root over all 62 served assets, and a seven-file sanitized raw-evidence manifest.
The evidence manifest root is
`06284fb7ee69c02b96c00d9edb05a1eae1bbef35aa591b8bcef76c141aea7581`.
Credentials, session tokens, prompts, raw model output, and browser session data
are omitted.
