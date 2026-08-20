/** Explicit extension boundary for adapter authors; not part of the consumer root API. */
export type * from "./public-contract.js";
export {
  createAgentDriverSdkWithRegistry,
} from "./sdk.js";
export { createAgentDriverRegistry, createBuiltinAgentDriverRegistry } from "./registry.js";
export type { AgentBackendRegistration, AgentBackendRegistrationOf, AgentDriverRegistry } from "./registry.js";
export type {
  AdapterEvent, AdapterLaunchConfig, AdapterLaunchContext, AdapterRuntimeContext, BackendAdapter, BackendConfig,
  BackendExecution, EncodeMessageOptions, InputMode, ProbeResult,
  SpawnedProcess, SpawnedProcessHandle, VendorSessionHandle,
} from "./internal/adapter.js";
export type {
  AgentDriverHost, CreateAgentDriverSdkOptions, DefaultAgentDriverHostOptions,
  PrepareExecutionInput, PrepareExecutionResult, PreparedExecutionResource, RawOutputEvent,
} from "./contract.js";
