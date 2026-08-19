/** Explicit extension boundary for adapter authors; not part of the consumer root API. */
export {
  createAgentDriverSdkWithRegistry,
} from "./sdk.js";
export { createAgentDriverRegistry, createBuiltinAgentDriverRegistry } from "./registry.js";
export type { AgentBackendRegistration, AgentBackendRegistrationOf, AgentDriverRegistry } from "./registry.js";
export type {
  AdapterEvent, AdapterLaunchContext, BackendAdapter, BackendExecution, EncodeMessageOptions, ProbeResult,
  SpawnedProcess, SpawnedProcessHandle, VendorSessionHandle,
} from "./internal/adapter.js";
