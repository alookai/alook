/**
 * Process-manager layer — host-side orchestration of agent runtime processes.
 *
 *   managerPolicy.ts  — pure reducer: single-flight, wake/sleep, queue/coalesce,
 *                       stalled detection. Side-effect free.
 *   managerRuntime.ts — thin executor: applies policy effects to real sessions,
 *                       runs the tick timer, feeds runtime events back in.
 */
export * from "./managerPolicy.js";
export * from "./managerRuntime.js";
export * from "./agentRouter.js";
