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
export * from "./types";
export * from "./drivers";
export {
  ChildProcessRuntimeSession,
  createChildProcessRuntimeSession,
  descriptorFromDriver,
  type RuntimeSessionDescriptor,
} from "./runtime/runtimeSession";
export { SdkRuntimeSession, type SdkSessionHandle } from "./runtime/sdkRuntimeSession";
export { RuntimeTurnState } from "./runtime/turnState";
export { RuntimeProgressState } from "./runtime/progressState";
export { RuntimeNotificationState } from "./runtime/notificationState";
export * from "./runtime/apmStateMachine";
export * from "./runtime/errorDiagnostics";
export * from "./inbox";
export * from "./manager";
export * from "./credentials";
export * from "./daemon";
export * from "./drivers/codexHome";
export { resolveSpawnSpec, type SpawnSpec } from "./drivers/probe";
export {
  resolveAlookCliPath,
  resolveAlookCliPathWithFallback,
  deriveCliFallbackCandidates,
  detectRuntimes,
  getAvailableRuntimes,
  type RuntimeInfo,
} from "./discovery";
