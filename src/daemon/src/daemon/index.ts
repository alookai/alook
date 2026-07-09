/**
 * Daemon layer — the runtime-agnostic host daemon factory.
 *
 *   createDaemon.ts — createDaemon(opts): connects the control plane, starts the
 *                     credential proxy (with inboxPull hook for timeline), and
 *                     runs injected agent sessions as subprocesses. No test/mock code.
 */
export * from "./createDaemon.js";
