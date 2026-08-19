/** Explicit extension boundary for adapter authors; not part of the consumer root API. */
export {
  createAgentDriverSdk as createBuiltinAgentDriverSdk,
  createAgentDriverSdkWithRegistry,
} from "./sdk.js";
export { createDefaultAgentDriverHost } from "./host/default-host.js";
export { createAgentDriverRegistry, createBuiltinAgentDriverRegistry } from "./registry.js";
export type { AgentBackendRegistration, AgentBackendRegistrationOf, AgentDriverRegistry } from "./registry.js";
export type {
  AdapterEvent, AdapterLaunchContext, BackendAdapter, BackendExecution, EncodeMessageOptions, ProbeResult,
  SpawnedProcess, SpawnedProcessHandle, VendorSessionHandle,
} from "./internal/adapter.js";
export type { AgentDriverHost, CreateAgentDriverSdkOptions, PreparedExecutionResource } from "./contract.js";
export * from "./contract.js";
