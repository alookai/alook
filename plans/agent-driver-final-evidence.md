# Agent-driver final evidence

Production code commit: `cd230633c840689408b9230e0f45c31565a6ffe7`

Production tree: `416299b1e5cd506a474666afc706bc778c0008b1`

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
| Agent-driver tests | PASS — 30 files / 306 tests |
| Daemon tests | PASS — 55 files / 1,105 tests |
| Workflow contracts | PASS — 13 tests |
| `node scripts/verify-agent-driver-ledger.mjs` | PASS — 8,284 collected cases, 568 mappings, zero missing targets; five semantic-audit claims valid |
| `node scripts/agent-driver-loc.mjs` | 10,829 lines vs 10,849 baseline (-20) |
| Clean daemon build | PASS — prior driver `dist` moved aside; prebuild rebuilt the package from source |
| Pack/install proofs | PASS — driver fixture 1 test; daemon packed boundary/version 2 tests |

The implementation commit hook repeated typecheck, lint, the full root test
suite, typegrep, and knip successfully before accepting the commit.

## Installed-backend lifecycle QA

The harness imported the clean-built package output and exercised real locally
installed backends. It recorded public receipts/events only.

| Backend | Installed version | Sanitized result |
| --- | --- | --- |
| Codex | 0.146.0 | Start/tool accepted; exact-turn interrupt accepted; logical turn ended `interrupted`; the physical process exit was truthfully reported `crashed`; exact returned-session-id resume succeeded, the resumed turn completed `success`, and requested stop closed `stopped`. Session SHA-256 prefix `4394e6d33764`; resumed text SHA-256 prefix `aa6ed6f431ff`. |
| Pi | 0.80.3 | Start accepted; tool start/finish observed; exact-turn interrupt accepted and ended `interrupted`; stop/close ended `stopped`; exact returned-session-id resume succeeded, the resumed turn completed `success`, and requested stop closed `stopped`. Session SHA-256 prefix `6aa76c55da2c`. |

## Independent `/c` QA

Independent agent: `alook-c-qa`

Run reference: `alook-c-qa-44047b78.c1WCPf`

The run used a fresh browser group and isolated local services on production
tree `f69005737a943fd291a6cb229bcfeaddb9a205be`. The later final-tree delta changes
only the Codex normalizer, its tests, the raw-to-manager regression, and the audit
ledger; the web runtime-selection and machine-control paths exercised here are
byte-identical. QA made no repository changes.

| Journey | Result | Sanitized evidence |
| --- | --- | --- |
| Supported runtime creation | PASS | Picker offered exactly Claude, Codex, Cursor, OpenCode, and Pi. `POST /api/community/bots` returned 201; the stored row used `runtime=codex`; the same bot id arrived in one `bot:added` frame at `2026-08-19T15:30:46.795Z`. |
| No-loss cancellation | PASS | Stored Gemini rendered unavailable. The complete normalized row was byte-identical before/after cancel: SHA-256 `1d6603eb25fed143f7eba711c11bb24923ef656652549a1d7b243fa7d4410f1b`; machine-control update count remained zero. |
| Removed-runtime recovery | PASS | The row stayed unchanged before save, then changed to `runtime=codex`, SHA-256 `213ca7234878e9766c2246195e844478743941faf90e87425c2e8dea67773136`; exactly one `agent:reset` carried `config.runtime=codex` at `2026-08-19T15:34:10.506Z`. |

The committed sanitized bundles `plans/agent-driver-final-qa-cd230633.json` and
`plans/agent-driver-final-qa-44047b78.json` record the exact backend commit/tree,
the scoped UI source commit/tree, installed backend outcomes, normalized row
hashes, runtime picker set, and control-frame counts.
Credentials, prompts, raw model output, and browser session data are omitted.
