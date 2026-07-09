/**
 * Inbox layer — how pending messages are projected into notices and how the
 * freshness guard decides whether an outgoing action may proceed.
 *
 *   projection.ts  — bucket pending messages by target → notice snapshots
 *   stateMachine.ts — pre-action freshness decision (forward / hold / bypass)
 */
export * from "./projection.js";
export * from "./stateMachine.js";
