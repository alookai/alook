# Server Rail PDD Spike Results

## Decision

**Go for a production migration checkpoint, with native PDD limited to pointer drag and the explicit Move menu retained for touch and keyboard.** The normalized reducer and list-item hitbox contract removed canonical drag-over mutation, every valid drop emitted one optimistic commit, and the tested cancel paths emitted no persistence batch.

This is not approval to land product code yet. Review of the four visual and interaction details remains the next gate. If native long-press touch dragging is a hard product requirement, the result is **No-go for PDD-only touch**: Chromium mobile emulation proves that PDD leaves swipe and tap alone, but it does not prove a reliable native long-press drag gesture. That requirement should keep a dedicated touch sensor or use the explicit Move action.

## Frozen scope

- Baseline: fresh main `61efa2343291875e08b96dd522869d9ccbf48713` (the production rail implementation files are byte-unchanged from the original `b5bc5fa854784ff8d77a7fcdb04b0edcb618629c` spike baseline)
- Branch: `spike/server-rail-pdd-fresh-main`
- Product files changed: none
- Fixture: 18 servers, 2 folders, 460 px desktop rail viewport, 520 px mobile rail viewport
- PDD surface: core element adapter, list-item hitbox, element auto-scroll, and live region only
- Excluded: channel-sidebar DnD, API/schema changes, server navigation, and production styling

## Browser evidence

Desktop Chromium passed these real-input journeys:

- A pointer down, 2 px sub-threshold move, and release incremented navigation once and produced zero drag commits.
- Bottom-quarter pointer drop reordered `a` after `b`; one optimistic commit and one persistence batch were recorded.
- Center pointer drop combined `a` and `b`; the persistence planner emitted one `create-folder` command.
- Drag-over changed only the preview instruction and indicator. Canonical state stayed byte-for-byte equal until drop.
- Leaving a collapsed folder after 200 ms prevented expansion; a continuous 550 ms combine hover expanded it.
- Escape and release outside all targets each restored the drag-start snapshot with zero commit and zero persistence batch.
- Dragging expanded folder `one` temporarily hid its children; cancel restored them.
- A 260 px wheel gesture scrolled natively. Holding a drag at the bottom edge increased `scrollTop` while canonical state stayed fixed.
- A forced persistence rejection rolled back the exact snapshot after one optimistic commit.
- The Move menu produced the same cross-folder reducer result, announced the literal outcome through the PDD live region, and restored focus to the moved server.

Mobile-emulated Chromium passed:

- A touch sequence of eight 18 px vertical moves scrolled the rail from a server row with zero click and zero drag commit.
- A short touch tap invoked the server action exactly once with zero drag commit.
- The explicit Move action moved `a` into folder `two` with one persistence batch.

WebKit was not run because no Playwright WebKit browser is installed locally. Physical iOS and Android remain required only if native long-press drag is reconsidered; the recommended contract does not depend on it.

The fresh-main rerun caught one real POC contract defect: sticky row drop targets retained the last folder instruction after the pointer left the rail, so an outside release could commit instead of cancel. The POC now uses non-sticky row targets. The exact cancel/hover journey then passed five consecutive focused repeats and the complete matrix; auto-scroll and valid drop targeting remained green.

## Reducer and persistence evidence

Eleven Vitest cases cover top-level before/after reorder, folder reorder, same-folder reorder, rail-to-folder, folder-to-rail, folder-to-folder, server combine, the 10-folder limit, duplicate/invalid state rejection, empty-folder deletion, zero-write no-ops, minimal command planning, and accessible labels.

The reducer owns the only canonical transition. PDD drag-over stores one `RailInstruction` preview and applies no state or persistence mutation. The final drop uses the immutable start snapshot, applies one reducer transition, computes the command set, and can restore that exact snapshot after rejection.

The platform's native drag API does not distinguish Escape from another no-target termination. The integration intentionally treats every final drop with no valid innermost instruction as the same zero-write cancel outcome.

## Dependency and bundle surface

The isolated production build contains 81 transformed modules:

- HTML: 0.64 kB raw / 0.39 kB gzip
- CSS: 2.22 kB raw / 0.98 kB gzip
- JavaScript including the fixture: 47.01 kB raw / 13.56 kB gzip

The runtime has no React or tree-wrapper dependency. Candidate exact packages are:

- `@atlaskit/pragmatic-drag-and-drop@3.0.0`
- `@atlaskit/pragmatic-drag-and-drop-hitbox@2.1.0`
- `@atlaskit/pragmatic-drag-and-drop-auto-scroll@3.1.0`
- `@atlaskit/pragmatic-drag-and-drop-live-region@2.0.0`

All four exact versions remained the current registry releases during the fresh-main rerun.

## Verification

- `pnpm typecheck` — pass
- `pnpm test` — 11 passed
- `pnpm test:browser` — 5 passed, 5 expected project skips
- focused hover/cancel stability rerun — 5 passed across five consecutive repeats
- `pnpm build` — pass
- `git diff --check` — pass
- POC implementation/config manifest SHA256 (excluding this report and generated evidence) — `e73d3b1a3a6ae3cadfd79ff9cb7d8673b24de00b748e47d2bbd518d8fc1edb40`
- Product diff relative to fresh main — empty; port 4177 free after teardown

The desktop combine-target and mobile Move-menu screenshots were visually inspected. They prove the interaction states are visible and usable in the fixture, but they are not production-design approval: the combine border strength, insertion-line treatment, 500 ms expansion feedback, and compact mobile Move flow remain the four explicit design-review items.

## Production recommendation

Proceed only after the design checkpoint. Keep the normalized state and persistence planner framework-independent. Use PDD list-item instructions for desktop pointer preview, commit once in the final monitor drop, and keep the existing server-folder API boundaries. Touch and keyboard should use the same reducer through the Move menu. Channel-sidebar dnd-kit remains untouched.

The proposed production file boundary is:

- `src/web/package.json`
- `pnpm-lock.yaml`
- `src/web/src/components/community/shell/server-rail.tsx`
- `src/web/src/components/community/shell/use-rail-order.ts`
- `src/web/src/components/community/shell/use-rail-order.test.ts`
- `src/web/src/components/community/shell/server-rail-actions.ts`
- `src/web/src/components/community/shell/server-rail-actions.test.ts`
- `src/web/src/test/e2e-ui/server-rail-dnd.spec.ts`

No production file should be touched until the insertion line, combine border, 500 ms expansion timing, and touch feedback receive their pending design review.
