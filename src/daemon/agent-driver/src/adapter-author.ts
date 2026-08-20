/** Explicit extension boundary for adapter authors; not part of the consumer root API. */
export const ADAPTER_AUTHOR_CONTRACT_VERSION = 1 as const;

export type * from "./public-contract.js";
export {
  createAgentDriverSdkWithRegistry,
} from "./sdk.js";
export { createAgentDriverRegistry, createBuiltinAgentDriverRegistry } from "./registry.js";
export type { AgentBackendRegistration, AgentBackendRegistrationOf, AgentDriverRegistry } from "./registry.js";
export type {
  AdapterEvent, AdapterLaunchConfig, AdapterLaunchContext, AdapterRuntimeContext, BackendAdapter, BackendConfig,
  AdapterTransport, BackendExecution, EncodeMessageOptions, InputMode, LaneAdmission,
  LaneInterruptInput, LaneSendInput, LaneStartInput, LaneStopInput, ProbeResult,
  RuntimeLane, RuntimeLaneEventMap, RuntimeLaneExit, RuntimeLaneOpenOptions,
  TerminalOwnership, WellKnownTransportKind,
  SpawnedProcess, SpawnedProcessHandle, VendorSessionHandle,
} from "./internal/adapter.js";
export type {
  AgentDriverHost, CreateAgentDriverSdkOptions, DefaultAgentDriverHostOptions,
  PrepareExecutionInput, PrepareExecutionResult, PreparedExecutionResource, RawOutputEvent,
} from "./contract.js";
