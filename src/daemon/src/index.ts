/**
 * Public entry point for the agent-backend layer.
 *
 * Typical use:
 *   import { getDriver, createChildProcessRuntimeSession } from "@alook/daemon";
 *   const driver = getDriver("claude");
 *   const session = createChildProcessRuntimeSession(driver, ctx);
 *   session.on("runtime_event", (e) => handle(e));
 *   await session.start({ text: initialPrompt });
 *   session.send({ text: "new message", mode: "busy" });  // steer mid-turn
 */
export * from "./types.js";
export * from "./drivers/index.js";
export {
  ChildProcessRuntimeSession,
  createChildProcessRuntimeSession,
  descriptorFromDriver,
  type RuntimeSessionDescriptor,
} from "./runtime/runtimeSession.js";
export { SdkRuntimeSession, type SdkSessionHandle } from "./runtime/sdkRuntimeSession.js";
export { RuntimeTurnState } from "./runtime/turnState.js";
export { RuntimeProgressState } from "./runtime/progressState.js";
export { RuntimeNotificationState } from "./runtime/notificationState.js";
export * from "./runtime/apmStateMachine.js";
export * from "./runtime/errorDiagnostics.js";
export * from "./inbox/index.js";
export * from "./manager/index.js";
export * from "./credentials/index.js";
export * from "./daemon/index.js";
export * from "./drivers/codexHome.js";
export { resolveSpawnSpec, type SpawnSpec } from "./drivers/probe.js";
export {
  resolveAlookCliPath,
  resolveAlookCliPathWithFallback,
  deriveCliFallbackCandidates,
  detectRuntimes,
  getAvailableRuntimes,
  type RuntimeInfo,
} from "./discovery.js";
